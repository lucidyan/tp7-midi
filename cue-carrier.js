// A prepared audio sidecar, not a query for TP-7's native marker table.
// 400 baud binary FSK survives the companion's 48 -> 16 kHz / ADPCM path.
const TP7CueCarrier = (() => {
    const SYNC = [0xD3, 0x91, 0x6B, 0xC5, 0xA7, 0x2E, 0x84, 0xF0];
    const MAX_CUES = 256, MAX_PAYLOAD = 1400, SYMBOL = 40;
    const STEPS = [7,8,9,10,11,12,13,14,16,17,19,21,23,25,28,31,34,37,41,45,50,55,60,66,73,80,88,97,107,118,130,143,157,173,190,209,230,253,279,307,337,371,408,449,494,544,598,658,724,796,876,963,1060,1166,1282,1411,1552,1707,1878,2066,2272,2499,2749,3024,3327,3660,4026,4428,4871,5358,5894,6484,7132,7845,8630,9493,10442,11487,12635,13899,15289,16818,18500,20350,22385,24623,27086,29794,32767];
    const INDEX = [-1,-1,-1,-1,2,4,6,8];
    const view = bytes => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const u32 = value => Number.isInteger(value) && value > 0 && value <= 0xFFFFFFFF;
    const encoder = new TextEncoder();

    function crc32(bytes) {
        let crc = 0xFFFFFFFF;
        for (const byte of bytes) {
            crc ^= byte;
            for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xEDB88320 : 0);
        }
        return (crc ^ 0xFFFFFFFF) >>> 0;
    }
    function helperName(filename, format = 'cue') {
        if (typeof filename !== 'string' || !/\.wav$/i.test(filename) || /[\0/\\]/.test(filename)) throw new Error('Expected a WAV filename without a path.');
        if (!['cue', 'txt', 'legacy-wav'].includes(format)) throw new Error('Unknown cue helper format.');
        const name = filename.slice(0, -4) + (format === 'legacy-wav' ? '.tp7-cues.wav' : `.${format}`);
        if (encoder.encode(name).length > 255) throw new Error('The filename is too long for a cue carrier.');
        return name;
    }
    function validate(source, expected) {
        helperName(source.filename);
        if (!u32(source.sampleRate) || source.sampleRate < 8000 || source.sampleRate > 192000 || !u32(source.numFrames)) throw new Error('Invalid source WAV length or sample rate.');
        if (!['wav', 'test'].includes(source.kind)) throw new Error('Unknown cue source.');
        if (!Array.isArray(source.cues) || source.cues.length > MAX_CUES) throw new Error(`A carrier supports 0–${MAX_CUES} cues.`);
        if (source.bpm !== null && (!Number.isFinite(source.bpm) || source.bpm <= 0 || source.bpm > 1000)) throw new Error('Invalid stored BPM.');
        if (expected && (source.filename !== expected.filename || source.sampleRate !== expected.sampleRate || source.numFrames !== expected.numFrames)) {
            throw new Error(`Cue carrier belongs to a different track (stored: ${source.filename}, ${source.sampleRate} Hz, ${source.numFrames} frames; selected: ${expected.filename}, ${expected.sampleRate} Hz, ${expected.numFrames} frames). Regenerate the companion after renaming or replacing the WAV.`);
        }
        let previous = -1;
        const cues = source.cues.map(value => {
            const sampleOffset = typeof value === 'number' ? value : value.sampleOffset;
            if (!Number.isInteger(sampleOffset) || sampleOffset < 0 || sampleOffset > source.numFrames || sampleOffset < previous) throw new Error('Invalid or unsorted cue sample offset.');
            previous = sampleOffset;
            const rate = BigInt(source.sampleRate);
            const positionMs = Number((2n * BigInt(sampleOffset) * 1000n + rate) / (2n * rate));
            const seekable = positionMs <= 0xFFFFFFFF && sampleOffset < source.numFrames && BigInt(positionMs) * rate < BigInt(source.numFrames) * 1000n;
            return { sampleOffset, positionMs, seekable };
        });
        return { filename: source.filename, sampleRate: source.sampleRate, numFrames: source.numFrames, kind: source.kind, bpm: source.bpm, cues };
    }
    function payload(source) {
        source = validate(source);
        const name = encoder.encode(source.filename);
        const bytes = new Uint8Array(24 + name.length + source.cues.length * 4);
        const data = view(bytes);
        bytes[0] = 1; bytes[1] = source.kind === 'test' ? 1 : 0;
        data.setUint32(2, source.sampleRate, true); data.setUint32(6, source.numFrames, true);
        data.setFloat64(10, source.bpm ?? 0, true);
        data.setUint16(18, name.length, true); data.setUint16(20, source.cues.length, true);
        // Bytes 22..23 are reserved and must stay zero.
        bytes.set(name, 24);
        source.cues.forEach((cue, i) => data.setUint32(24 + name.length + i * 4, cue.sampleOffset, true));
        return bytes;
    }
    function parsePayload(bytes, expected) {
        if (bytes.length < 28 || bytes.length > MAX_PAYLOAD || bytes[0] !== 1 || bytes[1] > 1 || bytes[22] || bytes[23]) throw new Error('Invalid cue carrier header.');
        const data = view(bytes), nameLength = data.getUint16(18, true), count = data.getUint16(20, true);
        if (bytes.length !== 24 + nameLength + count * 4 || nameLength > 255 || !nameLength || count > MAX_CUES) throw new Error('Invalid cue carrier length.');
        const filename = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(24, 24 + nameLength));
        const cues = Array.from({ length: count }, (_, i) => data.getUint32(24 + nameLength + i * 4, true));
        const bpm = data.getFloat64(10, true);
        return validate({ filename, sampleRate: data.getUint32(2, true), numFrames: data.getUint32(6, true), bpm: bpm === 0 ? null : bpm,
            kind: bytes[1] ? 'test' : 'wav', cues }, expected);
    }
    function frame(source) {
        const data = payload(source);
        if (data.length > MAX_PAYLOAD) throw new Error('Cue carrier payload is too large.');
        const bytes = new Uint8Array(8 + SYNC.length + 2 + data.length + 4);
        bytes.fill(0x55, 0, 8); bytes.set(SYNC, 8);
        view(bytes).setUint16(16, data.length, true); bytes.set(data, 18);
        // Cover length as well as payload. Sync is fixed and checked separately.
        view(bytes).setUint32(18 + data.length, crc32(bytes.subarray(16, 18 + data.length)), true);
        return bytes;
    }
    function makeWave(source, format = 'cue') {
        const bytes = frame(source), sampleRate = 48000, samplesPerBit = 120, leading = 7200;
        // Hardware can report natural completion after full 4000-sample/16 kHz blocks,
        // omitting the partial tail. Keep at least one second after the CRC and align
        // the WAV to 250 ms blocks; the v1 payload and leading timing stay unchanged.
        const blockFrames = 12000;
        const samples = Math.ceil((leading + bytes.length * 8 * samplesPerBit + sampleRate) / blockFrames) * blockFrames;
        const output = new Uint8Array(44 + samples * 2), data = view(output);
        const text = (offset, text) => output.set(encoder.encode(text), offset);
        text(0, 'RIFF'); data.setUint32(4, output.length - 8, true); text(8, 'WAVEfmt ');
        data.setUint32(16, 16, true); data.setUint16(20, 1, true); data.setUint16(22, 1, true);
        data.setUint32(24, sampleRate, true); data.setUint32(28, sampleRate * 2, true); data.setUint16(32, 2, true); data.setUint16(34, 16, true);
        text(36, 'data'); data.setUint32(40, samples * 2, true);
        let at = leading;
        for (const byte of bytes) for (let bit = 7; bit >= 0; bit--) {
            const cycles = byte & (1 << bit) ? 6 : 3;
            for (let i = 0; i < samplesPerBit; i++) data.setInt16(44 + (at++) * 2, Math.round(18000 * Math.sin(2 * Math.PI * cycles * i / samplesPerBit)), true);
        }
        return { bytes: output, filename: helperName(source.filename, format), seconds: samples / sampleRate, cueCount: source.cues.length };
    }

    // libGroAudio.so dvi_adpcm_decode: 3-byte header (signed BE predictor,
    // step index), high nibble first, no uncompressed initial sample.
    function decodeBlock(bytes) {
        if (bytes.length < 4 || bytes.length > 32768 || bytes[2] > 88) throw new Error(`Invalid TP-7 ADPCM block header (${bytes.length} bytes, step index ${bytes[2]}).`);
        let predictor = view(bytes).getInt16(0, false), index = bytes[2];
        const output = new Int16Array((bytes.length - 3) * 2);
        let at = 0;
        for (const byte of bytes.subarray(3)) for (const code of [byte >> 4, byte & 15]) {
            const step = STEPS[index];
            let delta = step >> 3;
            if (code & 4) delta += step;
            if (code & 2) delta += step >> 1;
            if (code & 1) delta += step >> 2;
            predictor = Math.max(-32768, Math.min(32767, predictor + ((code & 8) ? -delta : delta)));
            index = Math.max(0, Math.min(88, index + INDEX[code & 7]));
            output[at++] = predictor;
        }
        return output;
    }
    class Collector {
        constructor() { this.block = []; this.blockSize = 0; this.samples = []; this.sampleCount = 0; this.blocks = 0; this.started = false; }
        finishBlock() {
            if (!this.started) return;
            const bytes = new Uint8Array(this.blockSize);
            let at = 0; for (const part of this.block) { bytes.set(part, at); at += part.length; }
            const samples = decodeBlock(bytes);
            this.sampleCount += samples.length;
            if (this.sampleCount > 16000 * 40) throw new Error('Cue carrier audio exceeds 40 seconds.');
            this.samples.push(samples); this.blocks++;
            this.block = []; this.blockSize = 0; this.started = false;
        }
        push(type, bytes) {
            if (type === 2) { this.finishBlock(); this.started = true; }
            if (!this.started) throw new Error('Missing first ADPCM block packet.');
            this.blockSize += bytes.length;
            if (this.blockSize > 32768) throw new Error('Oversized ADPCM block.');
            this.block.push(bytes.slice());
        }
        finish() {
            this.finishBlock();
            const output = new Int16Array(this.sampleCount);
            let at = 0; for (const part of this.samples) { output.set(part, at); at += part.length; }
            this.samples = [];
            return output;
        }
    }

    const basis = [3, 6].map(cycles => ({
        sin: Array.from({ length: SYMBOL }, (_, i) => Math.sin(2 * Math.PI * cycles * i / SYMBOL)),
        cos: Array.from({ length: SYMBOL }, (_, i) => Math.cos(2 * Math.PI * cycles * i / SYMBOL)),
    }));
    function tone(samples, at) {
        const powers = basis.map(b => {
            let real = 0, imag = 0;
            // Ignore symbol edges, where the resampling filter mixes neighbours.
            for (let i = 4; i < SYMBOL - 4; i++) { real += samples[at + i] * b.cos[i]; imag += samples[at + i] * b.sin[i]; }
            return real * real + imag * imag;
        });
        const sum = powers[0] + powers[1];
        return { bit: powers[1] > powers[0] ? 1 : 0, confidence: sum ? Math.abs(powers[1] - powers[0]) / sum : 0 };
    }
    function decode(samples, expected, diagnostics = {}) {
        Object.assign(diagnostics, { sampleRate: 16000, receivedSamples: samples.length, receivedSeconds: samples.length / 16000 });
        if (samples.length < 8000 || samples.length > 16000 * 40) throw new Error('Cue carrier audio is too short or too long.');
        const syncBits = [...new Array(4).fill(0x55), ...SYNC].flatMap(byte => Array.from({ length: 8 }, (_, bit) => (byte >> (7 - bit)) & 1));
        let best = null;
        // Search the first 0.75 seconds over all sample phases; the WAV has
        // 150 ms leading silence and an 8-byte training sequence.
        for (let phase = 0; phase < SYMBOL; phase++) {
            const tones = [];
            for (let at = phase; at + SYMBOL <= Math.min(samples.length, 12000); at += SYMBOL) tones.push(tone(samples, at));
            for (let i = 0; i + syncBits.length <= tones.length; i++) {
                let confidence = 0, match = true;
                for (let j = 0; j < syncBits.length; j++) {
                    if (tones[i + j].bit !== syncBits[j] || tones[i + j].confidence < 0.25) { match = false; break; }
                    confidence += tones[i + j].confidence;
                }
                if (match && (!best || confidence > best.confidence)) best = { at: phase + (i + syncBits.length) * SYMBOL, confidence };
            }
        }
        if (!best) throw new Error('No cue carrier signal found. Check that the helper WAV was copied without editing.');
        let at = best.at;
        diagnostics.syncEndSample = at;
        function byte() {
            if (at + 8 * SYMBOL > samples.length) throw new Error('Truncated cue carrier audio.');
            let value = 0;
            for (let bit = 0; bit < 8; bit++, at += SYMBOL) {
                const t = tone(samples, at);
                if (t.confidence < 0.2) throw new Error('Unclear cue carrier signal; no markers accepted.');
                value = value * 2 + t.bit;
            }
            return value;
        }
        const low = byte(), high = byte(), length = low + high * 256;
        if (length < 28 || length > MAX_PAYLOAD) throw new Error('Invalid decoded cue carrier size.');
        Object.assign(diagnostics, { payloadBytes: length, requiredSamples: at + (length + 4) * 8 * SYMBOL });
        diagnostics.missingSamples = Math.max(0, diagnostics.requiredSamples - samples.length);
        if (diagnostics.missingSamples) {
            throw new Error(`Truncated cue carrier audio: received ${samples.length} samples, need ${diagnostics.requiredSamples} (${Math.ceil(diagnostics.missingSamples / 16)} ms missing). Regenerate the companion with this app or WAV Editor 1.3.1+ and copy it again; the new file includes a padded ending.`);
        }
        const protectedBytes = Uint8Array.from([low, high, ...Array.from({ length }, byte)]);
        const checksum = Uint8Array.from(Array.from({ length: 4 }, byte));
        if (crc32(protectedBytes) !== view(checksum).getUint32(0, true)) throw new Error('Cue carrier checksum failed; no markers accepted.');
        return { ...parsePayload(protectedBytes.subarray(2), expected), checksum: view(checksum).getUint32(0, true).toString(16).padStart(8, '0') };
    }
    function activeCueIndex(source, positionMs) {
        if (!source || !Number.isInteger(positionMs) || positionMs < 0 ||
            positionMs * source.sampleRate >= source.numFrames * 1000) return -1;
        let index = -1;
        // Last marker at/before the reported position owns the section. Equal
        // millisecond offsets select the last seekable cue; EOF markers never play.
        for (let i = 0; i < source.cues.length; i++) {
            if (source.cues[i].positionMs > positionMs) break;
            if (source.cues[i].seekable !== false) index = i;
        }
        return index;
    }
    return { helperName, validate, payload, parsePayload, makeWave, decodeBlock, Collector, decode, crc32, activeCueIndex, MAX_CUES };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = TP7CueCarrier;
