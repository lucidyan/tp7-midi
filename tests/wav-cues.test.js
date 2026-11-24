const { test } = require('node:test');
const assert = require('node:assert/strict');
const files = require('../wav-cues.js');
function wave(frames = 4800000) {
    const bytes = Buffer.alloc(44 + frames * 2 + 8 + 52 + 8 + 24);
    bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
    bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
    bytes.writeUInt32LE(48000, 24); bytes.writeUInt32LE(96000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
    bytes.write('data', 36); bytes.writeUInt32LE(frames * 2, 40);
    const cue = 44 + frames * 2;
    bytes.write('cue ', cue); bytes.writeUInt32LE(52, cue + 4); bytes.writeUInt32LE(2, cue + 8);
    for (let i = 0; i < 2; i++) {
        const at = cue + 12 + i * 24;
        bytes.writeUInt32LE(i + 3, at); bytes.write('data', at + 8); bytes.writeUInt32LE(i ? 480024 : 0, at + 20);
    }
    const acid = cue + 60;
    bytes.write('acid', acid); bytes.writeUInt32LE(24, acid + 4); bytes.writeFloatLE(127.5, acid + 28);
    return bytes;
}

const reader = bytes => ({ read: async (at, length) => bytes.subarray(at, at + length) });
test('local WAV reader preserves cue offsets and BPM without reading audio', async () => {
    const bytes = wave(); let read = 0;
    const metadata = await files.readWave({ read: async (at, n) => { read += n; return bytes.subarray(at, at + n); } }, bytes.length);
    assert.deepEqual(metadata.cues.map(cue => cue.sampleOffset), [0, 480024]);
    assert.equal(metadata.bpm, 127.5); assert.equal(metadata.numFrames, 4800000);
    assert.ok(read < 256);
});
test('local reader rejects truncated files, bad chunk lengths and out-of-track markers', async () => {
    for (const kind of ['truncated', 'chunk', 'cue', 'identity']) {
        let bytes = wave();
        if (kind === 'truncated') bytes = bytes.subarray(0, bytes.length - 1);
        if (kind === 'chunk') bytes.writeUInt32LE(0xFFFFFFFF, 40);
        if (kind === 'cue') bytes.writeUInt32LE(4800001, 9600044 + 12 + 20);
        await assert.rejects(files.readWave(reader(bytes), bytes.length, kind === 'identity' ? { sampleRate: 44100, numFrames: 4800000 } : null));
    }
});

test('conflicting valid BPM chunks cannot silently change the exported tempo', async () => {
    const original = wave();
    const duplicate = original.subarray(original.length - 32);
    const bytes = Buffer.concat([original, duplicate]);
    bytes.writeUInt32LE(bytes.length - 8, 4);
    assert.equal((await files.readWave(reader(bytes), bytes.length)).bpm, 127.5);
    bytes.writeFloatLE(128, bytes.length - 4);
    await assert.rejects(files.readWave(reader(bytes), bytes.length), /Conflicting BPM/);
});
