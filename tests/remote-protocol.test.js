const { test } = require('node:test');
const assert = require('node:assert/strict');
const remote = require('../remote-protocol.js');

function response(id, command, data, status = 0) {
    const bytes = remote.encode(id, command, data);
    bytes[6] &= ~0x40;
    bytes.splice(9, 0, status);
    return bytes;
}

test('matches captured TP-7 Start Session and Native Play frames', () => {
    assert.deepEqual(remote.encode(1, 127, [0x40]), [0xF0, 0, 0x20, 0x76, 0x19, 0x40, 0x60, 1, 127, 0, 0x40, 0xF7]);
    assert.deepEqual(remote.encode(2, 127, [0x50]), [0xF0, 0, 0x20, 0x76, 0x19, 0x40, 0x60, 2, 127, 0, 0x50, 0xF7]);
    assert.deepEqual(remote.encode(3, 6, [1, 3, 232]), [0xF0, 0, 0x20, 0x76, 0x19, 0x40, 0x60, 3, 6, 4, 1, 3, 104, 0xF7]);
});

test('decodes all byte values and all 12-bit request IDs without truncating', () => {
    const data = Array.from({ length: 256 }, (_, i) => i);
    for (const id of [1, 127, 128, 255, 2048, 4095]) {
        assert.deepEqual(remote.parse(response(id, 127, data)), { id, command: 127, status: 0, data });
    }
});

test('does not treat echoes, other devices or malformed payloads as replies', () => {
    assert.equal(remote.parse(remote.encode(1, 127, [0x40])), null);
    const other = response(1, 1, []); other[4] = 24;
    assert.equal(remote.parse(other), null);
    const bad = response(1, 1, [1]); bad[10] = 127;
    assert.equal(remote.parse(bad), null);
    assert.equal(remote.parse(response(1, 1, [1]).slice(0, -1)), null);
    assert.throws(() => remote.encode(0, 1));
    assert.throws(() => remote.encode(4096, 1));
    assert.throws(() => remote.encode(1, 1, [-1]));
});

test('BLE SysEx ends with a timestamp before F7', () => {
    const packets = remote.blePackets(remote.encode(1, 127, [64]), 0);
    assert.deepEqual(Array.from(packets[0]), [128, 128, 240, 0, 32, 118, 25, 64, 96, 1, 127, 0, 64, 128, 247]);
});

test('fragmented BLE replies round-trip across every timestamp low byte and packet edge', () => {
    for (let time = 0; time < 128; time++) {
        for (let size = 0; size < 50; size++) {
            const original = response(387, 6, Array.from({ length: size }, (_, i) => i * 7 & 255));
            const received = [];
            const receiver = new remote.BleReceiver(bytes => received.push(bytes));
            for (const packet of remote.blePackets(original, time, 20)) {
                assert.ok(packet.length <= 20);
                receiver.push(packet);
            }
            assert.deepEqual(received, [original]);
        }
    }
});

test('realtime and ordinary MIDI do not become cue events; reset drops partial messages', () => {
    const received = [];
    const receiver = new remote.BleReceiver(bytes => received.push(bytes));
    receiver.push([128, 128, 0x90, 60, 100, 129, 0xF8]);
    assert.deepEqual(received, []);
    receiver.push([128, 128, 0xF0, 0, 32]);
    receiver.reset();
    receiver.push([128, 118, 25, 128, 0xF7]);
    assert.deepEqual(received, []);
    for (const packet of remote.blePackets(response(1, 1, []), 247)) receiver.push(packet);
    assert.equal(received.length, 1);
});

test('decodes captured unsolicited position and playback events without treating them as replies', () => {
    const position = [240, 0, 32, 118, 25, 64, 64, 0, 127, 6, 77, 99, 6, 0, 0, 247];
    assert.equal(remote.parse(position), null);
    assert.deepEqual(remote.parseEvent(position), { command: 127, data: [77, 227, 134, 0, 0] });
    assert.deepEqual(remote.companionEvent(remote.parseEvent(position).data), { type: 'position', positionMs: 34531 });
    assert.deepEqual(remote.companionEvent([78, 0]), { type: 'playback', playing: false });
    assert.deepEqual(remote.companionEvent([78, 1]), { type: 'playback', playing: true });
    assert.equal(remote.companionEvent([78, 2]), null);
    assert.equal(remote.companionEvent([77, 1]), null);
    assert.equal(remote.parseEvent(remote.encode(1, 127, [77, 0, 0, 0, 0])), null, 'outgoing request echoes are not device events');
    assert.equal(remote.parseEvent(response(1, 127, [78, 1])), null);
    const malformed = [...position]; malformed[9] = 127;
    assert.equal(remote.parseEvent(malformed), null);
});

test('file event reads companion metadata and never derives cue count or BPM from a filename', () => {
    const data = [75, 128, 187, 0, 0, 0, 62, 73, 0, 5, 26, 11, 16, 22, 35, 0,
        ...Buffer.from('recordings\0example_cues_15_tempo_88.wav\0')];
    const decoded = remote.companionEvent(data);
    assert.equal(decoded.folder, 'recordings');
    assert.equal(decoded.filename, 'example_cues_15_tempo_88.wav');
    assert.equal(decoded.sampleRate, 48000);
    assert.equal(decoded.numFrames, 4800000);
    assert.equal(decoded.numTracks, 5);
    assert.equal(decoded.cueCount, undefined);
    assert.equal(decoded.bpm, undefined);
    assert.equal(remote.companionEvent(data.slice(0, -1)), null);
    assert.equal(remote.companionEvent([...data, 0]), null);
});

test('companion seek uses an exact unsigned little-endian millisecond offset', () => {
    assert.deepEqual(remote.seekData(10000), [76, 16, 39, 0, 0]);
    assert.deepEqual(remote.seekData(0x12345678), [76, 120, 86, 52, 18]);
    assert.deepEqual(remote.seekData(0xFFFFFFFF), [76, 255, 255, 255, 255]);
    for (const value of [-1, 1.5, NaN, 0x100000000]) assert.throws(() => remote.seekData(value));
});
