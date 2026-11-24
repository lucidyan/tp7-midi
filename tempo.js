// TP-7's experimentally documented mapping (MIDI_SPEC.md), not a measured
// hardware calibration. Keep decimal BPM arithmetic exact until presentation.
const TP7Tempo = (() => {
    const MIN_PITCH = -8192;
    const MAX_PITCH = 8191;

    function decimal(value) {
        const text = String(value).trim().replace(',', '.');
        if (text.length > 64 || !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)) {
            throw new Error('Enter a positive BPM using digits and a decimal point or comma.');
        }
        const [whole, fraction = ''] = text.split('.');
        const numerator = BigInt((whole || '0') + fraction);
        const denominator = 10n ** BigInt(fraction.length);
        if (numerator <= 0n) throw new Error('BPM must be greater than zero.');
        return { numerator, denominator };
    }

    function speedFraction(pitch) {
        if (!Number.isInteger(pitch) || pitch < MIN_PITCH || pitch > MAX_PITCH) {
            throw new Error('Pitch must be an integer from -8192 to 8191.');
        }
        return pitch < 0
            ? { numerator: 32768n + 3n * BigInt(pitch), denominator: 32768n }
            : { numerator: 8192n + BigInt(pitch), denominator: 8192n };
    }

    function multiplier(pitch) {
        const value = speedFraction(pitch);
        return Number(value.numerator) / Number(value.denominator);
    }

    function pitchBytes(pitch) {
        speedFraction(pitch); // Validate before bitwise encoding.
        const unsigned = pitch + 8192;
        return [0xE0, unsigned & 0x7F, (unsigned >> 7) & 0x7F];
    }

    function calculate(source, target) {
        const from = decimal(source);
        const to = decimal(target);
        const ratioN = to.numerator * from.denominator;
        const ratioD = to.denominator * from.numerator;
        if (ratioN * 4n < ratioD || ratioN * 8192n > ratioD * 16383n) {
            throw new Error('Target is outside the MIDI speed range: 0.25× to 1.9998779296875× the track BPM.');
        }

        const slower = ratioN < ratioD;
        const distance = slower ? ratioD - ratioN : ratioN - ratioD;
        const scaledN = distance * (slower ? 32768n : 8192n);
        const scaledD = ratioD * (slower ? 3n : 1n);
        // Nearest representable speed; exact half-step ties go toward unity.
        const whole = scaledN / scaledD;
        const rounded = whole + (2n * (scaledN % scaledD) > scaledD ? 1n : 0n);
        const pitch = Number(rounded) * (slower ? -1 : 1) || 0;
        const speed = speedFraction(pitch);
        const achievedN = from.numerator * speed.numerator;
        const achievedD = from.denominator * speed.denominator;
        // Subtract as integers, avoiding floating-point cancellation near zero.
        const errorN = achievedN * to.denominator - to.numerator * achievedD;
        const errorD = achievedD * to.denominator;
        return {
            pitch,
            multiplier: multiplier(pitch),
            achievedBpm: Number(achievedN) / Number(achievedD),
            errorBpm: Number(errorN) / Number(errorD),
            exact: errorN === 0n,
        };
    }

    return { calculate, multiplier, pitchBytes };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = TP7Tempo;
