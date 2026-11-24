// Independent fixture encoder for the documented 3-byte DVI packet variant.
const steps = [7,8,9,10,11,12,13,14,16,17,19,21,23,25,28,31,34,37,41,45,50,55,60,66,73,80,88,97,107,118,130,143,157,173,190,209,230,253,279,307,337,371,408,449,494,544,598,658,724,796,876,963,1060,1166,1282,1411,1552,1707,1878,2066,2272,2499,2749,3024,3327,3660,4026,4428,4871,5358,5894,6484,7132,7845,8630,9493,10442,11487,12635,13899,15289,16818,18500,20350,22385,24623,27086,29794,32767];
function encode(samples, blockSamples = 4096) {
    let predictor = 0, index = 0;
    const blocks = [];
    for (let start = 0; start < samples.length; start += blockSamples) {
        const count = Math.min(blockSamples, samples.length - start);
        if (count % 2) throw new Error('Fixture needs an even sample count.');
        const block = new Uint8Array(3 + count / 2);
        block[0] = predictor >> 8 & 255; block[1] = predictor & 255; block[2] = index;
        for (let i = 0; i < count; i++) {
            let diff = samples[start + i] - predictor, code = diff < 0 ? 8 : 0;
            diff = Math.abs(diff);
            let step = steps[index], quantized = step >> 3;
            for (const flag of [4, 2, 1]) {
                if (diff >= step) { code |= flag; diff -= step; quantized += step; }
                step >>= 1;
            }
            predictor += code & 8 ? -quantized : quantized;
            predictor = Math.min(32767, Math.max(-32768, predictor));
            index = Math.max(0, Math.min(88, index + [-1,-1,-1,-1,2,4,6,8][code & 7]));
            block[3 + (i >> 1)] |= i % 2 ? code : code << 4;
        }
        blocks.push(block);
    }
    return blocks;
}
function resample(wave, phase = 0, noise = 0) {
    const view = new DataView(wave.buffer, wave.byteOffset, wave.byteLength);
    const output = new Int16Array(Math.floor((wave.length - 44) / 6 / 2) * 2 + phase);
    // A short low-pass FIR, rather than just dropping two out of three samples.
    const kernel = [1, 2, 3, 2, 1];
    let seed = 24;
    for (let i = phase; i < output.length; i++) {
        let value = 0;
        for (let j = 0; j < 5; j++) {
            const at = 44 + ((i - phase) * 3 + j - 2) * 2;
            if (at >= 44 && at + 2 <= wave.length) value += view.getInt16(at, true) * kernel[j] / 9;
        }
        seed = (seed * 1664525 + 1013904223) >>> 0;
        output[i] = Math.round(value * 0.55 + (seed / 0xFFFFFFFF - 0.5) * noise);
    }
    return output.length % 2 ? output.slice(0, -1) : output;
}
module.exports = { encode, resample };
