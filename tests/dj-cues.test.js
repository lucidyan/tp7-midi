const { test } = require('node:test');
const assert = require('node:assert/strict');
const cues = require('../dj-cues.js');

test('48 kHz track at 88 BPM yields 15 four-bar jumps, derived independently from zero', () => {
    const grid = cues.createGrid({ bpm: '88', sampleRate: 48000, numFrames: 7832495 });
    assert.equal(grid.durationMs, 163177);
    assert.equal(grid.count, 15);
    assert.deepEqual(grid.pointAt(0), { index: 0, positionMs: 0, time: '0:00.000', bar: 1, beat: 1 });
    assert.deepEqual(grid.pointAt(14), { index: 14, positionMs: 152727, time: '2:32.727', bar: 57, beat: 1 });
    assert.equal(grid.pointAt(2).positionMs, 21818);
    assert.throws(() => grid.pointAt(15), RangeError);
});

test('decimal BPM and long files stay within half a millisecond without accumulated rounding', () => {
    const grid = cues.createGrid({ bpm: '127,125001', interval: 'beat-quarter', sampleRate: 48000, numFrames: 0xFFFFFFFF });
    assert.ok(grid.count > 700000);
    const denominator = 127125001n * 4n;
    for (const index of [0, 1, 31, 1024, 100000, grid.count - 1]) {
        const actual = BigInt(grid.pointAt(index).positionMs) * denominator;
        const ideal = BigInt(index) * 60000n * 1000000n;
        const error = actual > ideal ? actual - ideal : ideal - actual;
        assert.ok(error * 2n <= denominator, `rounding bound at cue ${index}`);
    }
    assert.notEqual(grid.pointAt(100000).positionMs, grid.pointAt(1).positionMs * 100000);
});

test('no ideal or rounded jump can reach EOF; fractional beats and meters label correctly', () => {
    const exact = cues.createGrid({ bpm: '120', interval: 'beat-1', sampleRate: 48000, numFrames: 48000 });
    assert.equal(exact.count, 2); // 0 and 500, never 1000.
    const nearEnd = cues.createGrid({ bpm: '170', interval: 'beat-1', sampleRate: 48000, numFrames: 16943 });
    assert.equal(nearEnd.count, 1); // 352.941… ms would round to 353, beyond 352.979… ms EOF.
    const half = cues.createGrid({ bpm: '120', interval: 'beat-half', beatsPerBar: 3, sampleRate: 48000, numFrames: 96000 });
    assert.equal(half.count, 8);
    assert.equal(half.pointAt(1).beat, 1.5);
    assert.equal(half.pointAt(5).beat, 3.5);
    assert.equal(half.pointAt(6).bar, 2);
    assert.equal(half.pointAt(6).beat, 1);
    for (const interval of Object.keys(cues.intervals)) {
        const grid = cues.createGrid({ bpm: '139.751', interval, sampleRate: 44100, numFrames: 7000000 });
        assert.ok(grid.pointAt(grid.count - 1).positionMs * 44100 < 7000000000);
    }
});

test('filename inference requires explicit, valid and unambiguous tempo labels', () => {
    for (const [filename, expected] of [
        ['Multitrack_48k_5stems_tempo_88_cues_15.wav', '88'],
        ['song_bpm_128.wav', '128'], ['song_127.125bpm.wav', '127.125'],
        ['song-TEMPO 088,500.wav', '88.5'], ['bpm_128_tempo_128.00.wav', '128'],
        ['song_bpm_128_tempo_129.wav', null], ['song_48k_cues_15_2026.wav', null],
        ['song_bpm_0.wav', null], ['song_bpm_1001.wav', null], ['song_bpm_128abc.wav', null],
        ['song_bpm_128.1234567.wav', null], ['song_bpm_128_tempo_0.wav', null],
    ]) assert.equal(cues.bpmFromFilename(filename), expected, filename);
});

test('invalid inputs and out-of-range device positions are rejected', () => {
    const options = { bpm: '120', sampleRate: 48000, numFrames: 48000 };
    for (const bpm of ['', '-120', '0', 'Infinity', '1e2', '120.0000001', '1001']) {
        assert.throws(() => cues.createGrid({ ...options, bpm }));
    }
    for (const patch of [{ sampleRate: 0 }, { numFrames: -1 }, { numFrames: 1.5 },
        { beatsPerBar: 0 }, { interval: '__proto__' }, { sampleRate: 1, numFrames: 0xFFFFFFFF }]) {
        assert.throws(() => cues.createGrid({ ...options, ...patch }));
    }
    const file = { folder: 'recordings', filename: 'song.wav', sampleRate: 48000, numFrames: 48000, numTracks: 2 };
    assert.notEqual(cues.trackKey(file), cues.trackKey({ ...file, numFrames: 96000 }));
});
