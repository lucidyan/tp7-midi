// File-timeline beat grid. All position calculations use exact integer ratios.
const TP7DJCues = (() => {
    const intervals = Object.freeze({
        'beat-quarter': [1, 4, '¼ beat'], 'beat-half': [1, 2, '½ beat'],
        'beat-1': [1, 1, '1 beat'], 'beat-2': [2, 1, '2 beats'],
        'bar-1': [1, 1, '1 bar'], 'bar-2': [2, 1, '2 bars'],
        'bar-4': [4, 1, '4 bars'], 'bar-8': [8, 1, '8 bars'],
        'bar-16': [16, 1, '16 bars'], 'bar-32': [32, 1, '32 bars'],
    });

    function parseBpm(value) {
        const text = String(value ?? '').trim().replace(',', '.');
        if (!/^\d{1,4}(?:\.\d{1,6})?$/.test(text)) return null;
        const [whole, fraction = ''] = text.split('.');
        const denominator = 10n ** BigInt(fraction.length);
        const numerator = BigInt(whole + fraction);
        if (numerator < denominator || numerator > 1000n * denominator) return null;
        const decimals = fraction.replace(/0+$/, '');
        return { numerator, denominator, text: String(Number(whole)) + (decimals ? `.${decimals}` : '') };
    }

    function bpmFromFilename(filename) {
        // Explicit labels only: ignore dates, sample rates and "cues_15".
        const text = String(filename ?? '').replace(/\.[a-z0-9]+$/i, '');
        const patterns = [
            /(?:^|[^a-z0-9])(?:bpm|tempo)[_ :=-]*(\d+(?:[.,]\d+)?)(?=$|[^a-z0-9.,])/gi,
            /(?:^|[^a-z0-9.,])(\d+(?:[.,]\d+)?)[_ -]*bpm(?=$|[^a-z0-9])/gi,
        ];
        const candidates = patterns.flatMap(pattern => [...text.matchAll(pattern)].map(match => parseBpm(match[1])));
        if (!candidates.length || candidates.some(value => !value)) return null;
        const first = candidates[0];
        if (candidates.some(value => value.numerator * first.denominator !== first.numerator * value.denominator)) return null;
        return first.text;
    }

    function trackKey(file) {
        return file ? JSON.stringify([file.folder, file.filename, file.sampleRate, file.numFrames, file.numTracks]) : null;
    }

    function formatTime(ms) {
        return `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
    }

    function createGrid({ bpm, interval = 'bar-4', beatsPerBar = 4, sampleRate, numFrames }) {
        const tempo = parseBpm(bpm);
        if (!tempo) throw new Error('Enter the original track BPM (1–1000, up to 6 decimal places).');
        if (!Number.isInteger(beatsPerBar) || beatsPerBar < 1 || beatsPerBar > 12) throw new Error('Choose 1–12 beats per bar.');
        if (!Object.hasOwn(intervals, interval)) throw new Error('Choose a jump interval.');
        if (![sampleRate, numFrames].every(value => Number.isInteger(value) && value > 0 && value <= 0xFFFFFFFF)) {
            throw new Error('Waiting for a valid track length from TP-7.');
        }
        const rate = BigInt(sampleRate);
        const durationNumerator = BigInt(numFrames) * 1000n;
        if (durationNumerator > 0xFFFFFFFFn * rate) throw new Error('This track exceeds the remote position range.');
        const [step, subdivision] = intervals[interval];
        const beatNumerator = BigInt(step * (interval.startsWith('bar-') ? beatsPerBar : 1));
        const beatDenominator = BigInt(subdivision);
        const a = 60000n * tempo.denominator * beatNumerator;
        const b = tempo.numerator * beatDenominator;
        const roundedMs = index => (2n * BigInt(index) * a + b) / (2n * b);
        const divisor = rate * a;
        // Number of nonnegative indices whose ideal positions precede EOF.
        let count = Number((durationNumerator * b + divisor - 1n) / divisor);
        // A last ideal position may round to EOF; it cannot be a playable cue.
        if (count && roundedMs(count - 1) * rate >= durationNumerator) count--;

        function pointAt(index) {
            if (!Number.isSafeInteger(index) || index < 0 || index >= count) throw new RangeError('Cue index outside this track.');
            const beats = BigInt(index) * beatNumerator;
            const barSize = beatDenominator * BigInt(beatsPerBar);
            const beat = 1 + Number(beats % barSize) / Number(beatDenominator);
            const positionMs = Number(roundedMs(index));
            return { index, positionMs, time: formatTime(positionMs), bar: Number(beats / barSize) + 1, beat };
        }

        return Object.freeze({ count, pointAt, bpm: tempo.text, interval, beatsPerBar,
            durationMs: Number((2n * durationNumerator + rate) / (2n * rate)),
            intervalLabel: intervals[interval][2] });
    }

    return { intervals, parseBpm, bpmFromFilename, trackKey, formatTime, createGrid };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = TP7DJCues;
