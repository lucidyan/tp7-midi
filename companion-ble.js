// TP-7 companion 1.1.4, TeMidiBleService / TeMidiOverBleSysexSendBuffer.
// This is a separate GATT service, not the standard BLE-MIDI characteristic.
const TP7CompanionBLE = (() => {
    const SERVICE = 'cc12911c-ce96-4100-9db2-35b1b534d5cf';
    const CHARACTERISTIC = '36a339c2-991a-486a-acfe-c840b39ae499';

    function packets(frame) {
        if (frame[0] !== 0xF0 || frame.at(-1) !== 0xF7) throw new Error('Expected a SysEx frame.');
        // Prefix 1 on EVERY packet; timestamps only at the start and before F7.
        // The companion sends 20-byte ATT values even after negotiating MTU 247.
        const output = [];
        let part = [1, 0x80, 0x80];
        for (const byte of frame.slice(0, -1)) {
            if (part.length === 20) { output.push(Uint8Array.from(part)); part = [1]; }
            part.push(byte);
        }
        if (part.length > 18) { output.push(Uint8Array.from(part)); part = [1]; }
        part.push(0x80, 0xF7);
        output.push(Uint8Array.from(part));
        return output;
    }

    class Receiver {
        constructor(onFrame, onAudio) { this.onFrame = onFrame; this.onAudio = onAudio; this.frame = []; }
        push(bytes) {
            if (bytes[0] === 2 || bytes[0] === 3) {
                const start = bytes[0] === 2 ? 5 : 1; // FIRST has a 4-byte block prefix.
                if (bytes.length < start) throw new Error('Truncated companion audio packet.');
                this.onAudio(bytes[0], bytes.subarray(start));
                return;
            }
            if (bytes[0] !== 1) return;
            let payload = Array.from(bytes.subarray(1));
            if (!this.frame.length) {
                if (payload.length < 3 || payload[0] < 128 || payload[1] < 128 || payload[2] !== 0xF0) return;
                payload = payload.slice(2);
            }
            if (this.frame.length + payload.length > 65536) { this.frame = []; throw new Error('Oversized companion SysEx.'); }
            const complete = payload.at(-1) === 0xF7;
            if (complete) {
                if (payload.length < 2 || payload.at(-2) < 128) { this.frame = []; throw new Error('Missing companion end timestamp.'); }
                payload.splice(-2, 1);
            }
            this.frame.push(...payload);
            if (complete) { const frame = this.frame; this.frame = []; this.onFrame(frame); }
        }
    }

    async function transfer({ device, file, protocol, check, signal, update, carrier }) {
        const summary = { method: 'TP-7 companion GATT', service: SERVICE, characteristic: CHARACTERISTIC,
            stage: 'service', result: 'testing', audioBytes: 0, firstPackets: 0, continuationPackets: 0,
            events: [], nativeCuesRead: false, mode: 'cue-carrier',
            targetFilename: carrier.filename };
        let endpoint, nextId = 0, waiting = null, sessionAttempted = false, transferAttempted = false;
        let receiving = false, streamResolve, streamReject, streamTimer, active = false, failure = null, audioComplete = false;
        let queue = Promise.resolve();
        const log = (kind, value = {}) => { summary.events.push({ kind, ...value }); if (summary.events.length > 40) summary.events.shift(); update(summary); };
        const guard = () => { check(); if (signal?.aborted) throw new Error('Cue loading cancelled.'); if (failure) throw failure; };
        const fail = error => { failure = error; waiting?.reject(error); streamReject?.(error); };
        const onAbort = () => fail(new Error('Cue loading cancelled.'));
        const receiver = new Receiver(frame => {
            const reply = protocol.parse(frame);
            const data = reply?.status === 0 ? reply.data : protocol.parseEvent(frame)?.data;
            if (data?.length) {
                if (data[0] === 0x45 && data.length === 2) active = data[1] === 1;
                if (data[0] === 0x49 && data.length === 2 && receiving) {
                    if (data[1] === 0) { audioComplete = true; streamResolve(); }
                    else streamReject(new Error(`Audio transfer ended with reason ${data[1]}.`));
                }
                const track = protocol.companionEvent(data);
                if (track?.type === 'file') log('track', { filename: track.filename, folder: track.folder,
                    sampleRate: track.sampleRate, numFrames: track.numFrames, numTracks: track.numTracks });
                if (track?.type === 'file' && [track.folder, track.filename, track.sampleRate, track.numFrames, track.numTracks].join('\0') !==
                    [file.folder, file.filename, file.sampleRate, file.numFrames, file.numTracks].join('\0')) {
                    fail(new Error('Track changed during cue loading.'));
                }
                if ([0x42, 0x45, 0x49].includes(data[0])) log('event', { data });
                else if (![0x4B, 0x4D, 0x4E, 0x4F].includes(data[0]) && !reply) log('event', { opcode: data[0], byteLength: data.length });
            }
            if (reply && waiting?.id === reply.id && waiting.command === reply.command) {
                log('reply', { id: reply.id, command: reply.command, status: reply.status, bytes: reply.data.length });
                if (reply.status === 0) waiting.resolve(reply);
                else if (reply.status !== 64) waiting.reject(new Error(`Companion command ${reply.command} rejected (status ${reply.status}).`));
            }
        }, (type, bytes) => {
            if (!receiving) return;
            if (type === 2) summary.firstPackets++;
            else {
                if (!summary.firstPackets) throw new Error('Audio continuation arrived without a first block.');
                summary.continuationPackets++;
            }
            summary.audioBytes += bytes.length;
            if (summary.audioBytes > 524288) throw new Error('Companion audio exceeded the receive limit.');
            carrier.push(type, bytes);
            update(summary);
        });
        const onNotification = event => {
            if (event.target !== endpoint) return;
            try {
                const view = event.target.value;
                receiver.push(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
            } catch (error) { fail(error); }
        };
        function request(command, data = [], cleanup = false) {
            if (!cleanup) guard();
            const id = ++nextId;
            log('request', { id, command, data });
            return new Promise((resolve, reject) => {
                let done = false;
                const finish = (fn, value) => {
                    if (done) return; done = true;
                    clearTimeout(timer); if (waiting?.id === id) waiting = null; fn(value);
                };
                const timer = setTimeout(() => finish(reject, new Error(`No companion reply to command ${command}.`)), cleanup ? 2000 : 5000);
                waiting = { id, command, resolve: value => finish(resolve, value), reject: error => finish(reject, error) };
                queue = queue.catch(() => {}).then(async () => {
                    for (const packet of packets(protocol.encode(id, command, data))) {
                        if (done) throw new Error('Companion request expired before transmission.');
                        if (!cleanup) guard();
                        if (!device.gatt.connected) throw new Error('Bluetooth disconnected.');
                        if (endpoint.properties?.writeWithoutResponse !== false && endpoint.writeValueWithoutResponse) await endpoint.writeValueWithoutResponse(packet);
                        else await endpoint.writeValueWithResponse(packet);
                    }
                });
                queue.catch(error => finish(reject, error));
            });
        }
        let guardTimer;
        try {
            guard(); update(summary);
            const service = await device.gatt.getPrimaryService(SERVICE);
            guard(); endpoint = await service.getCharacteristic(CHARACTERISTIC);
            guard(); endpoint.addEventListener('characteristicvaluechanged', onNotification);
            await endpoint.startNotifications(); guard();
            signal?.addEventListener('abort', onAbort);
            guardTimer = setInterval(() => { try { guard(); } catch (error) { fail(error); } }, 100);
            summary.stage = 'identify'; update(summary);
            const greeting = await request(1);
            const text = new TextDecoder().decode(Uint8Array.from(greeting.data)).replace(/\0/g, '');
            if (!text.split(';').some(part => part === 'product:TP-7')) throw new Error('Companion did not identify a TP-7.');
            summary.stage = 'session'; sessionAttempted = true; update(summary);
            await request(127, [0x40]);
            await request(127, [0x51]);
            summary.stage = 'enter-transfer'; transferAttempted = true; update(summary);
            for (const name of [file.folder, summary.targetFilename]) if (!name || name.includes('\0') || new TextEncoder().encode(name).length > 255) throw new Error('Invalid current track path.');
            await request(127, [0x43, 0, ...new TextEncoder().encode(file.folder), 0, ...new TextEncoder().encode(summary.targetFilename), 0]);
            // The app waits for FILE_TRANSFER_ACTIVE. An OK alone is insufficient.
            const deadline = Date.now() + 3000;
            while (!active) {
                guard(); if (Date.now() >= deadline) throw new Error('No FILE_TRANSFER_ACTIVE event from companion.');
                await new Promise(resolve => setTimeout(resolve, 25));
            }
            summary.stage = 'audio'; receiving = true; update(summary);
            const stream = new Promise((resolve, reject) => { streamResolve = resolve; streamReject = reject; });
            // Attach immediately: a notification can reject before the request ACK.
            stream.catch(() => {});
            streamTimer = setTimeout(() => streamReject(new Error('Cue file transfer timed out after 40 seconds.')), 40000);
            // The companion uses (0, 0) for a complete file.
            await request(127, [0x46, 0, 0, 0, 0, 0, 0, 0, 0]);
            await stream; guard();
            if (!summary.audioBytes || !summary.firstPackets) throw new Error('Audio transfer ended without data.');
            summary.stage = 'decode'; update(summary);
            await new Promise(resolve => setTimeout(resolve, 0)); guard();
            summary.carrier = carrier.finish(file); guard();
            summary.result = 'cues-decoded';
        } catch (error) {
            summary.result = signal?.aborted ? 'cancelled' : 'failed'; summary.error = error.message;
        } finally {
            receiving = false; clearTimeout(streamTimer); clearInterval(guardTimer);
            signal?.removeEventListener('abort', onAbort);
            summary.lastStage = summary.stage; summary.stage = 'cleanup'; update(summary);
            summary.audioComplete = audioComplete;
            summary.decoder = carrier.stats();
            summary.cleanupErrors = [];
            if (endpoint && device.gatt.connected) {
                for (const opcode of [...(transferAttempted ? (audioComplete ? [0x44] : [0x48, 0x44]) : []), ...(sessionAttempted ? [0x41] : [])]) {
                    try { await request(127, [opcode], true); }
                    catch (error) { summary.cleanupErrors.push(error.message); }
                }
                endpoint.removeEventListener('characteristicvaluechanged', onNotification);
                try { await endpoint.stopNotifications(); } catch { /* Disconnection can race cleanup. */ }
            } else endpoint?.removeEventListener('characteristicvaluechanged', onNotification);
            summary.stage = 'done'; update(summary);
        }
        return summary;
    }
    function readCarrier(options, codec) {
        const collector = new codec.Collector();
        const diagnostics = {};
        return transfer({ ...options, carrier: {
            filename: codec.helperName(options.file.filename, options.helperFormat || 'cue'),
            push: (type, bytes) => collector.push(type, bytes),
            stats: () => ({ decodedSamples: collector.sampleCount, decodedBlocks: collector.blocks, pendingBlockBytes: collector.blockSize, ...diagnostics }),
            finish: expected => {
                const samples = collector.finish();
                return { ...codec.decode(samples, expected, diagnostics), decodedSamples: samples.length, decodedBlocks: collector.blocks };
            },
        } });
    }
    return { SERVICE, CHARACTERISTIC, packets, Receiver, readCarrier };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = TP7CompanionBLE;
