// Live track/transport session for opt-in cue mode. No settings or FILE probes.
document.addEventListener('DOMContentLoaded', () => {
    const protocol = TP7RemoteProtocol;
    const element = id => document.getElementById(id);
    let live = { file: null, position: null, playback: null };
    const pending = new Map();
    const receiver = new protocol.BleReceiver(receive);
    let nextId = 0, generation = 0, fileRevision = 0;
    let activeEndpoint = null, notificationEndpoint = null, inputEndpoint = null;
    let busy = false, enabled = false, identified = false, sessionConfirmed = false;
    let positionReceivedAt = null;
    const fileKey = file => file ? JSON.stringify([file.folder, file.filename, file.sampleRate, file.numFrames, file.numTracks]) : null;
    const getState = () => ({ file: live.file ? { ...live.file } : null,
        positionMs: live.position?.positionMs ?? null, playing: live.playback?.playing ?? null,
        positionAgeMs: positionReceivedAt === null ? null : Math.max(0, performance.now() - positionReceivedAt),
        connected: !!isMidiConnected(), ready: enabled && !!isMidiConnected() && sessionConfirmed,
        enabled, busy, connection: generation });
    function status(text, error = false) {
        element('remote-status').textContent = text;
        element('remote-status').dataset.status = error ? 'error' : '';
    }
    function showLive() {
        const { file, position, playback } = live;
        element('remote-file').textContent = file ? file.filename : 'Waiting for the current track…';
        element('remote-position').textContent = position ? TP7DJCues.formatTime(position.positionMs) : '—';
        element('remote-playback').textContent = !playback ? 'Unknown' : playback.playing ? 'Playing' : 'Stopped';
        element('remote-file-info').textContent = file?.sampleRate > 0 ?
            `${TP7DJCues.formatTime(Math.round(file.numFrames * 1000 / file.sampleRate))} · ${file.numTracks} tracks` : '';
    }
    function resetLive() {
        fileRevision++; positionReceivedAt = null;
        live = { file: null, position: null, playback: null };
        showLive();
    }
    function recordCompanion(data) {
        const decoded = protocol.companionEvent(data);
        if (!decoded) return;
        if (decoded.type === 'position') {
            positionReceivedAt = performance.now();
            live.position = { positionMs: decoded.positionMs };
        } else if (decoded.type === 'file') {
            if (fileKey(live.file) !== fileKey(decoded)) resetLive();
            live.file = decoded;
        } else live.playback = { playing: decoded.playing };
        showLive(); buttons();
    }
    function buttons() {
        const connected = !!isMidiConnected();
        element('cue-mode-content').hidden = !enabled;
        element('remote-session').disabled = !enabled || busy || !connected;
        element('remote-session').textContent = sessionConfirmed ? 'Restart listening' : 'Start listening';
        element('remote-play').disabled = !enabled || busy || !connected || !sessionConfirmed;
        element('remote-stop').disabled = !enabled || busy || !connected || !sessionConfirmed;
        document.dispatchEvent(new CustomEvent('tp7-remote-state', { detail: getState() }));
    }
    function detach() {
        for (const waiter of pending.values()) waiter.reject(new Error('Cue mode or connection changed.'));
        if (notificationEndpoint) notificationEndpoint.removeEventListener('characteristicvaluechanged', onNotification);
        if (inputEndpoint) inputEndpoint.onmidimessage = null;
        notificationEndpoint = null; inputEndpoint = null; receiver.reset();
    }
    function connectionChanged() {
        const endpoint = isMidiConnected() ? (connectionType === 'ble' ? bleMidiCharacteristic : midiOutput) : null;
        if (endpoint !== activeEndpoint) {
            generation++; detach(); activeEndpoint = endpoint;
            identified = false; sessionConfirmed = false; resetLive();
            status(endpoint ? 'Enable cue mode and start listening.' : 'Connect TP-7 first.');
        }
        buttons();
    }
    function receive(bytes) {
        if (!enabled) return;
        const reply = protocol.parse(bytes);
        if (!reply) {
            const event = protocol.parseEvent(bytes);
            if (event) recordCompanion(event.data);
            return;
        }
        if (reply.command === 127 && reply.status === 0) recordCompanion(reply.data);
        const waiter = pending.get(reply.id);
        if (!waiter || reply.command !== waiter.command) return;
        if (reply.status === 0) waiter.resolve(reply);
        else if (reply.status !== 64) waiter.reject(new Error(`TP-7 rejected command ${reply.command} (status ${reply.status}).`));
    }
    function onNotification(event) {
        if (event.target !== notificationEndpoint || activeEndpoint !== notificationEndpoint) return;
        const view = event.target.value;
        receiver.push(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
    }
    async function listen(token) {
        if (connectionType === 'ble') {
            const endpoint = bleMidiCharacteristic;
            if (notificationEndpoint === endpoint) return;
            if (!endpoint?.startNotifications) throw new Error('This browser connection cannot receive Bluetooth replies.');
            endpoint.addEventListener('characteristicvaluechanged', onNotification);
            notificationEndpoint = endpoint;
            try {
                await endpoint.startNotifications();
                if (token !== generation) throw new Error('Connection changed.');
            } catch (error) {
                endpoint.removeEventListener('characteristicvaluechanged', onNotification);
                if (notificationEndpoint === endpoint) notificationEndpoint = null;
                throw error;
            }
        } else {
            const access = await navigator.requestMIDIAccess({ sysex: true });
            if (token !== generation) throw new Error('Connection changed.');
            if (!access.sysexEnabled) throw new Error('Allow MIDI SysEx access in the browser, then try again.');
            const output = access.outputs.get(midiOutput.id);
            if (!output) throw new Error('The selected USB output is unavailable with SysEx access. Reconnect it.');
            const matches = [...access.inputs.values()].filter(port => port.state !== 'disconnected' && port.name === output.name);
            if (matches.length !== 1) throw new Error('Could not identify one matching TP-7 MIDI input.');
            if (inputEndpoint) inputEndpoint.onmidimessage = null;
            inputEndpoint = matches[0];
            inputEndpoint.onmidimessage = event => {
                if (token === generation && connectionType === 'usb') receive(Array.from(event.data));
            };
            await inputEndpoint.open();
            if (token !== generation) throw new Error('Connection changed.');
            // Use the output from the access object with SysEx permission.
            midiOutput = output;
            activeEndpoint = output;
        }
    }

    function send(bytes, token, isPending) {
        const check = () => {
            if (!enabled || token !== generation || !isMidiConnected()) throw new Error('Connection changed. Start listening again.');
            if (!isPending()) throw new Error('Request expired before transmission.');
        };
        check();
        if (connectionType === 'usb') {
            midiOutput.send(bytes);
            return Promise.resolve();
        }
        const endpoint = bleMidiCharacteristic;
        const write = bleWriteQueue.then(async () => {
            check();
            for (const packet of protocol.blePackets(bytes, performance.now())) {
                check();
                if (endpoint !== bleMidiCharacteristic) throw new Error('Bluetooth connection changed.');
                await endpoint.writeValueWithoutResponse(packet);
            }
        });
        bleWriteQueue = write.catch(() => {});
        return write;
    }

    function request(command, data, token, isCurrent = () => true) {
        nextId = nextId % 4095 + 1;
        const id = nextId;
        return new Promise((resolve, reject) => {
            const finish = (callback, value) => {
                clearTimeout(timer);
                pending.delete(id);
                callback(value);
            };
            const timer = setTimeout(() => finish(reject, new Error('No TP-7 reply within 5 seconds. The command is not confirmed.')), 5000);
            pending.set(id, {
                command,
                resolve: value => finish(resolve, value),
                reject: error => finish(reject, error),
            });
            try { Promise.resolve(send(protocol.encode(id, command, data), token, () => pending.has(id) && isCurrent())).catch(error => finish(reject, error)); }
            catch (error) { finish(reject, error); }
        });
    }

    async function run(operation) {
        if (busy) return false;
        connectionChanged();
        const token = generation;
        busy = true;
        status('Waiting for TP-7…');
        buttons();
        try {
            if (!enabled || !isMidiConnected()) throw new Error('Enable cue mode and connect TP-7 first.');
            await listen(token);
            await operation(token);
            return true;
        } catch (error) {
            if (token === generation) status(error.message, true);
            return false;
        } finally { busy = false; buttons(); }
    }

    function startListening() {
        return run(async token => {
            identified = false; sessionConfirmed = false; resetLive(); buttons();
            status('Connecting to the TP-7 track session…');
            const greeting = await request(1, [], token);
            const text = new TextDecoder().decode(new Uint8Array(greeting.data)).replace(/\0/g, '');
            if (!text.split(';').includes('product:TP-7')) throw new Error('The reply did not identify a TP-7.');
            identified = true;
            await request(127, [0x40], token);
            if (token !== generation || !enabled) throw new Error('Cue mode changed.');
            sessionConfirmed = true;
            status('Listening to the current track.');
        });
    }
    element('remote-session').addEventListener('click', startListening);
    element('cue-mode').addEventListener('change', () => {
        enabled = element('cue-mode').checked;
        if (!enabled) {
            generation++; detach(); identified = false; sessionConfirmed = false; resetLive();
            status('Cue mode is off.');
        }
        buttons();
        if (enabled && isMidiConnected() && !busy) startListening();
    });
    async function transport(opcode) {
        await run(async token => {
            if (!sessionConfirmed) throw new Error('Start listening first.');
            if (opcode === 0x50) {
                await transmitMidiBatch([[0xB0, TP7.CC_REC_ARM, 0], [0xB0, TP7.CC_CUE_REC, 0]], () => token === generation);
                state.cueRecMode = false;
                element('cue-rec-off').classList.add('active');
                element('cue-rec-on').classList.remove('active', 'rec-active');
            }
            status('Waiting for transport acknowledgement…');
            await request(127, [opcode], token);
            status(opcode === 0x50 ? 'Playing.' : 'Stopped.');
        });
    }
    element('remote-play').addEventListener('click', () => transport(0x50));
    element('remote-stop').addEventListener('click', () => transport(0x51));
    function jumpTo(positionMs, selectionIsCurrent = () => true) {
        const file = live.file;
        const revision = fileRevision;
        const connection = generation;
        return run(async token => {
            if (!sessionConfirmed || !Number.isInteger(positionMs) || positionMs < 0 || positionMs > 0xFFFFFFFF ||
                !file || file.sampleRate <= 0 || positionMs * file.sampleRate >= file.numFrames * 1000) {
                throw new Error('Select a cue within the current track and start listening.');
            }
            const isCurrent = () => enabled && token === connection && token === generation && revision === fileRevision &&
                fileKey(live.file) === fileKey(file) && selectionIsCurrent();
            await transmitMidiBatch([[0xB0, TP7.CC_REC_ARM, 0], [0xB0, TP7.CC_CUE_REC, 0]], isCurrent);
            state.cueRecMode = false;
            element('cue-rec-off').classList.add('active');
            element('cue-rec-on').classList.remove('active', 'rec-active');
            status('Stopping playback before the position jump…');
            await request(127, [0x51], token, isCurrent);
            status('Waiting for the position command acknowledgement…');
            await request(127, protocol.seekData(positionMs), token, isCurrent);
            await request(127, [0x50], token, isCurrent);
            if (!isCurrent()) throw new Error('Track, connection or jump selection changed.');
            status(`Playing from ${(positionMs / 1000).toFixed(3)} s.`);
        });
    }
    function runCompanionTask(operation) {
        return run(async token => {
            if (!identified || !sessionConfirmed || !live.file || connectionType !== 'ble') {
                throw new Error('Connect via Bluetooth and start listening first.');
            }
            const file = { ...live.file }, revision = fileRevision;
            let clean = false;
            window.tp7CompanionBusy = true;
            live.position = null; live.playback = null; positionReceivedAt = null; showLive();
            try {
                await bleWriteQueue;
                const check = () => {
                    if (!enabled || token !== generation || revision !== fileRevision || !isMidiConnected()) throw new Error('Track, mode or connection changed.');
                };
                check();
                clean = await operation(bleDevice, file, check);
            } finally {
                window.tp7CompanionBusy = false;
                if (token === generation) {
                    sessionConfirmed = false;
                    status('Start listening again to use playback controls.');
                    if (clean && enabled && revision === fileRevision) {
                        await request(127, [0x40], token, () => enabled && token === generation && revision === fileRevision);
                        if (enabled && token === generation && revision === fileRevision) {
                            sessionConfirmed = true;
                            status('Listening. Cue loading leaves playback stopped.');
                        }
                    }
                }
            }
        });
    }
    async function enableCueMode() {
        if (busy) return false;
        enabled = true; element('cue-mode').checked = true; buttons();
        if (!getState().ready && !await startListening()) return false;
        if (live.file) return true;
        // The session ACK can precede the unsolicited current-file event.
        const token = generation;
        return new Promise(resolve => {
            const finish = ok => { clearTimeout(timer); document.removeEventListener('tp7-remote-state', changed); resolve(ok); };
            const changed = () => {
                if (token !== generation || !enabled || !isMidiConnected()) finish(false);
                else if (getState().ready && live.file) finish(true);
            };
            const timer = setTimeout(() => {
                status('No current track received. Select a track on TP-7 and try again.', true);
                finish(false);
            }, 5000);
            document.addEventListener('tp7-remote-state', changed);
            changed();
        });
    }
    window.tp7RemotePanel = { connectionChanged, getState, jumpTo, runCompanionTask, enableCueMode };
    connectionChanged();
});
