const { test } = require('node:test');
const assert = require('node:assert/strict');
const companion = require('../companion-ble.js');
const protocol = require('../remote-protocol.js');
const codec = require('../cue-carrier.js');
const audio = require('./helpers/carrier-audio.cjs');

test('companion packet layout matches the app, including continuation without a BLE header', () => {
    const frame = protocol.encode(1, 127, [64]);
    assert.deepEqual([...companion.packets(frame)[0]], [1, 128, 128, 240, 0, 32, 118, 25, 64, 96, 1, 127, 0, 64, 128, 247]);
    // Fixed incoming fragments: two timestamp bytes at start, one before F7.
    const found = [];
    const receiver = new companion.Receiver(bytes => found.push(bytes), () => {});
    receiver.push(Uint8Array.from([1, 128, 128, 240, 0, 32, 118, 25, 64, 32, 1, 127, 0, 0, 66]));
    receiver.push(Uint8Array.from([1, 1, 129, 247]));
    assert.deepEqual(protocol.parse(found[0]), { id: 1, command: 127, status: 0, data: [66, 1] });
});

test('every packet boundary preserves SysEx and does not insert continuation timestamps', () => {
    for (let size = 0; size < 150; size++) {
        const frame = protocol.encode(15, 1, Array.from({ length: size }, (_, i) => i));
        const found = [];
        const receiver = new companion.Receiver(bytes => found.push(bytes), () => {});
        for (const packet of companion.packets(frame)) { assert.ok(packet.length <= 20); receiver.push(packet); }
        assert.deepEqual(found, [frame]);
    }
});

test('audio types are demultiplexed without misreading raw audio as MIDI', () => {
    const chunks = [];
    const receiver = new companion.Receiver(() => assert.fail('audio is not MIDI'), (type, bytes) => chunks.push([type, [...bytes]]));
    receiver.push(Uint8Array.from([2, 0, 0, 0, 0, 240, 247, 255]));
    receiver.push(Uint8Array.from([3, 128, 0, 255]));
    assert.deepEqual(chunks, [[2, [240, 247, 255]], [3, [128, 0, 255]]]);
    assert.throws(() => receiver.push(Uint8Array.from([2, 1, 2])), /Truncated/);
});

function fixture(mode = 'ok') {
    const requests = [], reports = [], listeners = new Set();
    const controller = new AbortController();
    const file = { folder: 'recordings', filename: 'example.wav', sampleRate: 48000, numFrames: 480000, numTracks: 1 };
    let changed = false, stopped = false;
    const emit = bytes => {
        const padded = new Uint8Array(bytes.length + 4); padded.set(bytes, 2);
        endpoint.value = new DataView(padded.buffer, 2, bytes.length);
        for (const listener of listeners) listener({ target: endpoint });
    };
    const event = data => {
        const frame = protocol.encode(1, 127, data); frame[6] = 64; frame[7] = 0;
        for (const packet of companion.packets(frame)) emit(packet);
    };
    const decoder = new companion.Receiver(frame => {
        const reply = [...frame]; reply[6] &= ~64; reply.splice(9, 0, 0);
        const request = protocol.parse(reply); requests.push([request.command, ...request.data]);
        const data = request.command === 1 ? [...new TextEncoder().encode('product:TP-7;sw_version:1.1.11;')] : [];
        const response = protocol.encode(request.id, request.command, data); response[6] &= ~64; response.splice(9, 0, 0);
        if (mode === 'reject' && request.data[0] === 0x43) response[9] = 2;
        for (const packet of companion.packets(response)) emit(packet);
        if (request.data[0] === 0x43) event([0x45, 1]);
        if (request.data[0] === 0x46) {
            if (mode === 'cancel') { controller.abort(); return; }
            if (mode === 'track-change') { changed = true; return; }
            if (mode === 'orphan') { emit(Uint8Array.from([3, 1, 2])); return; }
            if (mode === 'empty') { event([0x49, 0]); return; }
            const wave = codec.makeWave({ ...file, kind: 'wav', bpm: 128, cues: [0, 240000] });
            for (const block of audio.encode(audio.resample(wave.bytes))) {
                emit(Uint8Array.from([2, 0, 0, 0, 0, ...block.slice(0, 239)]));
                for (let at = 239; at < block.length; at += 243) emit(Uint8Array.from([3, ...block.slice(at, at + 243)]));
            }
            event([0x49, 0]);
        }
    }, () => {});
    const endpoint = {
        properties: { writeWithoutResponse: true },
        addEventListener: (_, listener) => listeners.add(listener), removeEventListener: (_, listener) => listeners.delete(listener),
        async startNotifications() {}, async stopNotifications() { stopped = true; },
        async writeValueWithoutResponse(packet) { decoder.push(packet); },
    };
    const device = { gatt: { connected: true, async getPrimaryService(uuid) {
        assert.equal(uuid, companion.SERVICE);
        if (mode === 'missing') throw new Error('Service unavailable');
        return { async getCharacteristic(uuid) { assert.equal(uuid, companion.CHARACTERISTIC); return endpoint; } };
    } } };
    return { requests, reports, listeners, get stopped() { return stopped; },
        run: () => companion.readCarrier({ device, file, protocol, signal: controller.signal,
            check: () => { if (changed) throw new Error('Track changed.'); }, update: summary => reports.push(JSON.stringify(summary)) }, codec) };
}

test('cue transfer decodes markers and BPM then exits transfer and ends the session', async () => {
    const f = fixture(); const result = await f.run();
    assert.equal(result.result, 'cues-decoded'); assert.ok(result.audioBytes >= 4096);
    assert.deepEqual(f.requests.map(r => r.slice(0, 2)), [[1], [127, 64], [127, 81], [127, 67], [127, 70], [127, 68], [127, 65]]);
    assert.deepEqual(f.requests[3], [127, 67, 0, ...new TextEncoder().encode('recordings\0example.cue\0')]);
    assert.equal(result.carrier.bpm, 128); assert.equal(result.carrier.cues.length, 2); assert.equal(result.nativeCuesRead, false); assert.deepEqual(result.cleanupErrors, []);
    assert.equal(f.listeners.size, 0); assert.equal(f.stopped, true);
    assert.ok(!JSON.stringify(result).includes('sw_version')); // Greeting/serial and audio payloads are not logged.
});

test('missing companion service sends no commands', async () => {
    const f = fixture('missing'); const result = await f.run();
    assert.equal(result.result, 'failed'); assert.equal(result.lastStage, 'service'); assert.deepEqual(f.requests, []);
});

test('rejection, cancellation, track change and malformed audio all clean up without success', async () => {
    for (const mode of ['reject', 'cancel', 'track-change', 'orphan', 'empty']) {
        const f = fixture(mode); const result = await f.run();
        assert.notEqual(result.result, 'cues-decoded', mode);
        const cleanup = mode === 'empty' ? [[127, 68], [127, 65]] : [[127, 72], [127, 68], [127, 65]];
        assert.deepEqual(f.requests.slice(-cleanup.length), cleanup, mode);
        assert.equal(f.listeners.size, 0, mode);
    }
});
