// TE SysEx envelope, verified against TE's web updater. Companion
// session/transport opcodes have separate experimental evidence.
// Position commands and events were checked against the companion
// Android app. No native cue-list/selection opcode has been established.
const TP7RemoteProtocol = (() => {
    const MAX_MESSAGE = 65536;

    function encode(id, command, data = []) {
        if (!Number.isInteger(id) || id < 1 || id > 4095 ||
            !Number.isInteger(command) || command < 0 || command > 127 ||
            data.length > MAX_MESSAGE || data.some(n => !Number.isInteger(n) || n < 0 || n > 255)) {
            throw new Error('Invalid SysEx request.');
        }
        const packed = [];
        for (let offset = 0; offset < data.length; offset += 7) {
            const group = data.slice(offset, offset + 7);
            packed.push(group.reduce((mask, value, index) => mask | ((value >> 7) << index), 0));
            packed.push(...group.map(value => value & 127));
        }
        return [0xF0, 0, 0x20, 0x76, 0x19, 0x40, 0x60 | (id >> 7), id & 127, command, ...packed, 0xF7];
    }

    function isFrame(bytes) {
        return bytes.length >= 10 && bytes.length <= MAX_MESSAGE &&
            [0xF0, 0, 0x20, 0x76, 0x19, 0x40].every((value, i) => bytes[i] === value) &&
            bytes.at(-1) === 0xF7 &&
            bytes.slice(1, -1).every(value => Number.isInteger(value) && value >= 0 && value <= 127);
    }

    function unpack(packed) {
        if (packed.length % 8 === 1) return null;
        const data = [];
        for (let offset = 0; offset < packed.length; offset += 8) {
            const mask = packed[offset];
            const count = Math.min(7, packed.length - offset - 1);
            if (mask >> count) return null;
            for (let i = 0; i < count; i++) data.push(packed[offset + i + 1] | (((mask >> i) & 1) << 7));
        }
        return data;
    }

    function parse(bytes) {
        if (!isFrame(bytes) || bytes.length < 11 || (bytes[6] & 0x40)) return null;
        const data = unpack(bytes.slice(10, -1));
        if (!data) return null;
        return {
            id: (bytes[6] & 0x20) ? ((bytes[6] & 31) << 7) | bytes[7] : 0,
            command: bytes[8], status: bytes[9], data,
        };
    }

    function parseEvent(bytes) {
        // Real TP-7 1.1.11 capture: unsolicited events use request framing,
        // flags 0x40 and ID 0, without a response status byte. They must never
        // acknowledge a pending request or be confused with our TX echoes.
        if (!isFrame(bytes) || bytes[6] !== 0x40 || bytes[7] !== 0 || bytes[8] !== 127) return null;
        const data = unpack(bytes.slice(9, -1));
        return data?.length ? { command: 127, data } : null;
    }

    function companionEvent(data) {
        // Layout checked against companion 1.1.4 and the user's 1.1.11 BLE
        // capture. These events contain no native cue list or cue selection.
        if (data[0] === 0x4D && data.length === 5) {
            const positionMs = data[1] + data[2] * 256 + data[3] * 65536 + data[4] * 16777216;
            return { type: 'position', positionMs };
        }
        if (data[0] === 0x4E && data.length === 2 && (data[1] === 0 || data[1] === 1)) {
            return { type: 'playback', playing: data[1] === 1 };
        }
        if (data[0] === 0x4B && data.length >= 20) {
            // Companion reads two uint32 LE values, a track-count byte, six
            // date/time bytes and two null-terminated UTF-8 strings.
            const separator = data.indexOf(0, 16);
            const end = separator < 0 ? -1 : data.indexOf(0, separator + 1);
            if (separator <= 16 || end <= separator + 1 || end !== data.length - 1) return null;
            try {
                const decoder = new TextDecoder('utf-8', { fatal: true });
                const folder = decoder.decode(new Uint8Array(data.slice(16, separator)));
                const filename = decoder.decode(new Uint8Array(data.slice(separator + 1, end)));
                if (/[\u0000-\u001F\u007F]/.test(folder + filename)) return null;
                const u32 = offset => data[offset] + data[offset + 1] * 256 + data[offset + 2] * 65536 + data[offset + 3] * 16777216;
                return { type: 'file', folder, filename, sampleRate: u32(1), numFrames: u32(5), numTracks: data[9], rawMetadata: data.slice(1, 16) };
            } catch { return null; }
        }
        return null;
    }

    function seekData(positionMs) {
        if (!Number.isInteger(positionMs) || positionMs < 0 || positionMs > 0xFFFFFFFF) throw new Error('Invalid playback position.');
        // Tp7NewRecorderService.SetPosition: opcode byte 0x4C followed by a
        // uint32 millisecond offset, serialized with BitConverter.GetBytes.
        return [0x4C, positionMs & 255, positionMs >>> 8 & 255, positionMs >>> 16 & 255, positionMs >>> 24];
    }

    function blePackets(message, time, packetSize = 20) {
        if (message[0] !== 0xF0 || message.at(-1) !== 0xF7 || packetSize < 4) {
            throw new Error('Expected a complete SysEx message.');
        }
        const header = 0x80 | ((Math.floor(time) >> 7) & 63);
        const timestamp = 0x80 | (Math.floor(time) & 127);
        const packets = [];
        let packet = [header, timestamp];
        for (const byte of message.slice(0, -1)) {
            if (packet.length === packetSize) { packets.push(packet); packet = [header]; }
            packet.push(byte);
        }
        // BLE-MIDI requires a timestamp before F7, including at a packet edge.
        if (packet.length + 2 > packetSize) { packets.push(packet); packet = [header]; }
        packet.push(timestamp, 0xF7);
        packets.push(packet);
        return packets.map(value => new Uint8Array(value));
    }

    class BleReceiver {
        constructor(onMessage) { this.onMessage = onMessage; this.reset(); }
        reset() { this.message = null; }
        push(bytes) {
            if (bytes.length < 2 || (bytes[0] & 0xC0) !== 0x80) return;
            let afterTimestamp = false;
            for (let i = 1; i < bytes.length; i++) {
                const byte = bytes[i];
                if (byte < 128) {
                    afterTimestamp = false;
                    if (this.message) {
                        this.message.push(byte);
                        if (this.message.length >= MAX_MESSAGE) this.reset();
                    }
                } else if (!afterTimestamp) {
                    afterTimestamp = true;
                } else {
                    afterTimestamp = false;
                    if (byte === 0xF0) this.message = [byte];
                    else if (byte === 0xF7 && this.message) {
                        const complete = [...this.message, byte];
                        this.reset();
                        this.onMessage(complete);
                    } else if (byte < 0xF8) this.reset();
                }
            }
        }
    }

    return { encode, parse, parseEvent, companionEvent, seekData, blePackets, BleReceiver };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = TP7RemoteProtocol;
