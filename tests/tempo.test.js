const { test } = require('node:test');
const assert = require('node:assert/strict');
const tempo = require('../tempo.js');

test('known acceleration, slowdown and unity examples', () => {
    assert.deepEqual(tempo.calculate('120', '128'), {
        pitch: 546, multiplier: 1.066650390625,
        achievedBpm: 127.998046875, errorBpm: -0.001953125, exact: false,
    });
    assert.equal(tempo.calculate('128', '120').pitch, -683);
    assert.equal(tempo.calculate('128', '120').achievedBpm, 119.99609375);
    assert.equal(tempo.calculate('120', '60').pitch, -5461);
    assert.equal(tempo.calculate('120', '30').pitch, -8192);
    assert.equal(tempo.calculate('120', '180').pitch, 4096);
    assert.equal(tempo.calculate('127,125', '127.125').pitch, 0);
    assert.equal(tempo.calculate('127,125', '127.125').exact, true);
});

test('all 16,384 representable speeds round-trip exactly and encode correctly', () => {
    for (let pitch = -8192; pitch <= 8191; pitch++) {
        const source = pitch < 0 ? 32768 : 8192;
        const target = pitch < 0 ? 32768 + 3 * pitch : 8192 + pitch;
        const match = tempo.calculate(String(source), String(target));
        assert.equal(match.pitch, pitch, `pitch ${pitch}`);
        assert.equal(match.exact, true);
        assert.equal(match.errorBpm, 0);
        const bytes = tempo.pitchBytes(pitch);
        assert.equal(bytes[0], 0xE0);
        assert.ok(bytes[1] >= 0 && bytes[1] < 128);
        assert.ok(bytes[2] >= 0 && bytes[2] < 128);
        assert.equal(bytes[1] + bytes[2] * 128 - 8192, pitch);
    }
});

test('half-step ties choose unity; arbitrarily close decimals choose the correct side', () => {
    assert.equal(tempo.calculate('16384', '16385').pitch, 0);
    assert.equal(tempo.calculate('16384', '16385.000000000000000001').pitch, 1);
    assert.equal(tempo.calculate('16384', '16384.999999999999999999').pitch, 0);
    assert.equal(tempo.calculate('65536', '65533').pitch, 0);
    assert.equal(tempo.calculate('65536', '65532.999999999999999999').pitch, -1);
    assert.equal(tempo.calculate('65536', '65533.000000000000000001').pitch, 0);
    assert.notEqual(tempo.calculate('16384', '16384.000000000000000001').errorBpm, 0);
});

test('chosen pitch minimizes absolute BPM error across the entire MIDI domain', () => {
    // Independent exhaustive search on an integer grid with denominator 32768.
    // Inputs are BPM thousandths; no copy of the inverse formula under test.
    let seed = 1307;
    for (let i = 0; i < 100; i++) {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        const source = 40000 + seed % 240000;
        seed = (seed * 1664525 + 1013904223) >>> 0;
        const target = Math.ceil(source / 4) + seed % Math.floor(source * 1.7);
        const match = tempo.calculate((source / 1000).toFixed(3), (target / 1000).toFixed(3));
        const actualGrid = match.pitch < 0 ? 32768 + 3 * match.pitch : 32768 + 4 * match.pitch;
        const chosenError = Math.abs(source * actualGrid - target * 32768);
        for (let candidate = -8192; candidate <= 8191; candidate++) {
            const grid = candidate < 0 ? 32768 + 3 * candidate : 32768 + 4 * candidate;
            assert.ok(chosenError <= Math.abs(source * grid - target * 32768));
        }
    }
});

test('rejects invalid input and targets beyond the true endpoint without clamping', () => {
    for (const bad of ['', ' ', '0', '-120', 'Infinity', 'NaN', '1e2', '120bpm', '1,2.3', '1 20', '9'.repeat(65)]) {
        assert.throws(() => tempo.calculate(bad, '120'), undefined, bad);
        assert.throws(() => tempo.calculate('120', bad), undefined, bad);
    }
    assert.equal(tempo.calculate('8192', '16383').pitch, 8191);
    assert.throws(() => tempo.calculate('120', '240'), /outside/);
    assert.throws(() => tempo.calculate('120', '29.99999999999999999'), /outside/);
    assert.throws(() => tempo.calculate('8192', '16383.000000000000001'), /outside/);
    for (const bad of [-8193, 8192, 0.5, NaN, Infinity]) assert.throws(() => tempo.pitchBytes(bad));
});
