// Local WAV marker/BPM reader. Skips audio bytes; performs no device requests.
const TP7WavCues = (() => {
    async function readWave(reader, size, expected = null) {
        const read = async (offset, length) => {
            const data = await reader.read(offset, length);
            if (data.length !== length) throw new Error('Truncated WAV metadata.');
            return data;
        };
        const ascii = bytes => String.fromCharCode(...bytes);
        const view = bytes => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const header = await read(0, 12);
        if (ascii(header.slice(0, 4)) !== 'RIFF' || ascii(header.slice(8, 12)) !== 'WAVE') throw new Error('The selected file is not a RIFF WAV.');
        const end = view(header).getUint32(4, true) + 8;
        if (end !== size) throw new Error('WAV RIFF length differs from the file size.');
        let offset = 12;
        let format = null;
        let dataSize = null;
        let cueRecords = null;
        let bpm = null;
        const chunks = [];
        while (offset < end) {
            if (chunks.length >= 128 || offset + 8 > end) throw new Error('Invalid WAV chunk table.');
            const chunk = await read(offset, 8);
            const name = ascii(chunk.slice(0, 4));
            const length = view(chunk).getUint32(4, true);
            const body = offset + 8;
            const next = body + length + (length & 1);
            if (next > end) throw new Error('WAV chunk exceeds the file.');
            chunks.push({ name, offset, size: length });
            if (name === 'fmt ') {
                if (format || length < 16) throw new Error('Invalid WAV format chunk.');
                const data = view(await read(body, 16));
                format = { code: data.getUint16(0, true), channels: data.getUint16(2, true), sampleRate: data.getUint32(4, true), blockAlign: data.getUint16(12, true) };
            } else if (name === 'data') {
                if (dataSize !== null) throw new Error('Multiple WAV audio chunks are not supported.');
                dataSize = length; // Skip its bytes by file offset.
            } else if (name === 'cue ') {
                if (cueRecords || length < 4 || length > 4 + 24 * 2048) throw new Error('Invalid or oversized WAV cue chunk.');
                const data = view(await read(body, length));
                const count = data.getUint32(0, true);
                if (length !== 4 + count * 24) throw new Error('WAV cue count does not match its chunk.');
                cueRecords = [];
                for (let i = 0; i < count; i++) {
                    const start = 4 + i * 24;
                    const target = ascii(new Uint8Array(data.buffer, data.byteOffset + start + 8, 4));
                    if (target !== 'data' || data.getUint32(start + 12, true) || data.getUint32(start + 16, true)) throw new Error('Unsupported WAV cue addressing.');
                    cueRecords.push({ id: data.getUint32(start, true), sampleOffset: data.getUint32(start + 20, true) });
                }
            } else if (name === 'acid' && length >= 24) {
                const data = view(await read(body, 24));
                const tempo = data.getFloat32(20, true);
                if (Number.isFinite(tempo) && tempo >= 1 && tempo <= 1000) {
                    if (bpm !== null && bpm !== tempo) throw new Error('Conflicting BPM values in WAV metadata.');
                    bpm = tempo;
                }
            }
            offset = next;
        }
        if (!format || ![1, 3, 0xFFFE].includes(format.code) || !format.sampleRate || !format.channels || !format.blockAlign || dataSize === null || dataSize % format.blockAlign) throw new Error('Unsupported WAV audio format.');
        const numFrames = dataSize / format.blockAlign;
        if (expected !== null && (format.sampleRate !== expected.sampleRate || numFrames !== expected.numFrames)) throw new Error('WAV sample rate or length does not match the current TP-7 track.');
        const ids = new Set();
        const cues = (cueRecords || []).map(cue => {
            if (ids.has(cue.id) || cue.sampleOffset > numFrames || (expected !== null && cue.sampleOffset === numFrames)) throw new Error('Duplicate or out-of-track WAV cue.');
            ids.add(cue.id);
            const positionMs = Number((2n * BigInt(cue.sampleOffset) * 1000n + BigInt(format.sampleRate)) / (2n * BigInt(format.sampleRate)));
            if (expected !== null && positionMs * format.sampleRate >= numFrames * 1000) throw new Error('WAV cue rounds to the file endpoint.');
            return { ...cue, positionMs };
        }).sort((a, b) => a.sampleOffset - b.sampleOffset || a.id - b.id);
        return { sampleRate: format.sampleRate, numFrames, bpm, cues, chunks };
    }
    return { readWave };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = TP7WavCues;
