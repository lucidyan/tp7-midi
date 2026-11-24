# TP-7 cue session and companion format

This document describes the implemented protocol and its validation boundaries.
The browser uses two Bluetooth characteristics: ordinary BLE-MIDI for the live
track session and transport, and the TP-7 companion channel for the prepared cue
file. USB SysEx can also carry the live session; cue-file transfer requires BLE.

Cue-file loading, time jumps and live highlighting have been checked on TP-7
firmware 1.1.11 in Bluefy. Other firmware/browser combinations are not established
by these results. No native cue-list or cue-number-selection command is used.
A prepared cue file supplies the marker positions; jumping does not switch the
recorder's native CUE selection. Tempo matching has separate arithmetic and
hardware limitations documented in [MIDI_SPEC.md](../MIDI_SPEC.md#bpm-matching-and-precision).

## Code map

| Module | Responsibility |
| --- | --- |
| `remote-protocol.js` | SysEx framing, BLE-MIDI packets, live event decoding and seek offsets |
| `remote-panel.js` | Opt-in session, request lifetimes, Play/Stop and guarded cue jumps |
| `companion-ble.js` | Companion GATT transfer, deadlines and cleanup |
| `cue-carrier.js` | Versioned carrier format, FSK/ADPCM codec and validation |
| `wav-cues.js` | Local RIFF marker/BPM reads, skipping audio data |
| `carrier-panel.js` | Per-track auto-load, cue paging and live section highlighting |
| `tempo.js` / `app.js` | Exact BPM calculation and serialized MIDI application |
| `dj-cues.js` / `dj-panel.js` | Optional beat/bar grid from tempo and track duration |

## Live session

The SysEx header is `F0 00 20 76 19 40`. Host requests then carry
`60 | (id >> 7)`, `id & 7F`, the command, packed data, and `F7`. IDs are 1–4095.
Each group of up to seven data bytes is encoded as a high-bit mask followed by
seven-bit values. Responses use response flags and a status byte before data.
Status 0 acknowledges success; status 64 is progress and does not end the timeout.
A request expires after five seconds, including time spent waiting in the BLE
write queue. Expired or stale requests must not later be transmitted.

Command 1 identifies the device through semicolon-separated fields including
`product:TP-7`. Session/transport commands use outer command `7F`:

| Payload opcode | Meaning |
| --- | --- |
| `40` | Start session |
| `41` | End session |
| `50` | Resume playback at the current position |
| `51` | Stop playback |
| `4C` + uint32 LE | Seek to a millisecond offset |

For example, seeking to 10,000 ms uses payload `4C 10 27 00 00`. A cue jump
releases recording arm and cue recording, then waits for each Stop → Seek → Play
acknowledgement. Failed seeks never fall through to Play. Connection, track and
selection guards are checked again before queued messages are written.

Unsolicited events have flags `40`, ID byte 0, outer command `7F`, and packed data
starting at byte 9 with **no status byte**. They cannot acknowledge a request:

| Event | Decoded payload |
| --- | --- |
| `4B` | uint32 LE sample rate, uint32 LE frame count, track-count byte, six date/time bytes, NUL-terminated UTF-8 folder and filename |
| `4D` | uint32 LE playback position in milliseconds |
| `4E` | one byte: 0 stopped, 1 playing |

The file event contains neither marker positions nor stored BPM. A session ACK
may precede the file event; **Read from cue** waits up to five seconds for the
current file before starting its transfer. Turning cue mode off removes listeners
and invalidates pending work. It does not send a transport Play or Stop command.

## Companion GATT transfer

- Service: `cc12911c-ce96-4100-9db2-35b1b534d5cf`
- Characteristic: `36a339c2-991a-486a-acfe-c840b39ae499`
- MIDI packets start with type 1 on every fragment, including continuations.
  Initial and final timestamps surround the SysEx frame; continuation fragments
  have no ordinary BLE-MIDI header. Requests use 20-byte ATT packets.
- Type 2 starts an audio block; skip its following four-byte prefix.
- Type 3 continues the audio block without that prefix.

Transfer sequence: identify TP-7 → start session → Stop → open the prepared file
→ wait for transfer-active → request its audio → decode → close transfer/session.

| Opcode | Meaning |
| --- | --- |
| `43`, track 0, folder + NUL, filename + NUL | Open the named companion file |
| `45 01` | Transfer-active event; an ACK alone is insufficient |
| `46` + two zero uint32 LE arguments | Request complete file audio |
| `49 00` | Natural audio completion |
| `48` | Abort an incomplete transfer |
| `44` | Leave file transfer |

Normal cue loading requests the source basename with `.cue` in the observed
folder. The legacy `.tp7-cues.wav` name is also supported. It does not list files,
query native WAV chunks over Bluetooth, or modify files/firmware. The helper is
encoded audio that survives the companion's transcoding; ordinary text CUE sheets
are not interchangeable with it.

Bounds: 512 KiB compressed data, 40 seconds transfer time, 40 seconds decoded
16 kHz audio, 32 KiB per ADPCM block. Cleanup requests have two-second deadlines.
The transfer is aborted only when natural completion has not occurred. After
confirmed cleanup the normal live session is reopened, leaving playback stopped.
Cleanup failure suppresses cue buttons and requires reconnecting. Track changes,
disconnection and cancellation invalidate the result. Received audio stays in
memory and is never uploaded or saved by the reader.

## ADPCM and prepared carrier

Each compressed block has a signed **big-endian** 16-bit predictor and a one-byte
step index. Nibbles begin at byte 3, high nibble first. The predictor itself is not
emitted; a block yields `(bytes - 3) * 2` samples. Predictor and index are clamped
to signed 16-bit and 0–88. The step/index tables are the standard IMA tables.
This differs from little-endian IMA WAV framing and from the four-byte header in
[RFC 3551 DVI4](https://www.rfc-editor.org/rfc/rfc3551#section-4.5.1).

The prepared file is mono, signed 16-bit PCM at 48 kHz. It encodes bits MSB first
at 400 baud: 1200 Hz for zero and 2400 Hz for one, with 120 samples per bit. The
companion's 16 kHz output has 40 samples per symbol. The frame is:

1. Eight `55` training bytes.
2. Sync `D3 91 6B C5 A7 2E 84 F0`.
3. uint16 LE payload length.
4. Payload v1.
5. uint32 LE CRC-32/IEEE over the length and payload.

All multibyte payload numbers are little-endian:

| Offset | Field |
| --- | --- |
| 0 | Version 1 |
| 1 | Source kind: 0 WAV markers; 1 legacy test points (labelled as such) |
| 2 | uint32 original sample rate |
| 6 | uint32 original frame count |
| 10 | float64 stored BPM; zero means absent |
| 18 | uint16 UTF-8 filename byte count |
| 20 | uint16 marker count, 0–256 |
| 22 | Two reserved zero bytes |
| 24 | UTF-8 original filename, then uint32 marker sample offsets in order |

Generators prepend 150 ms of silence and append at least one second of silence,
rounding the total length up to 250 ms. A device capture ended after complete
4000-sample blocks and omitted an old helper's partial tail; tests reproduce that
truncation. Padding keeps payload and CRC before the potentially omitted ending.
It does not alter payload v1, so complete older helpers still decode.

The decoder searches the initial 0.75 seconds over all 40 symbol phases, checks
training/sync, compares quadrature tone energy and validates CRC. Weak signals,
truncation, unknown versions, nonzero reserved bytes, invalid UTF-8/ranges and
mismatched filename/sample rate/frame count produce no accepted cues or BPM.
This identity check is not a hash of the music: re-export after renaming, replacing
audio or editing markers. CRC detects corruption; it is not authentication.

## UI and timing rules

Auto-load is once per track selection after a confirmed stopped state. Unknown or
playing states wait; a missing/failed helper requires manual retry. Explicit
**Read from cue** and **Reload cues** perform an immediate read and stop playback.
BPM is accepted only from a validated matching file. Reading never applies speed.
A track change clears the old source BPM; manual edits during transfer take
precedence over its result. Missing stored BPM leaves manual entry available.

Each marker is independently rounded to the nearest millisecond using integer
arithmetic: `(2 * sampleOffset * 1000 + sampleRate) / (2 * sampleRate)`, with integer
division. EOF markers, including those rounding to EOF, are retained but disabled.
There is no cumulative interval rounding and no live-beat quantization.

The active section is the last seekable cue at/before the reported position;
equal rounded positions select the last cue. No section is active at EOF. During
playback a position older than three seconds loses its highlight until refreshed;
a confirmed stopped position may remain selected. Page following responds to cue
changes, allowing manual browsing between changes. The optional grid uses the
original BPM, duration and a first beat at zero; it does not analyze audio.

## Protocol evidence

The SysEx envelope was checked against TE's web updater. Companion operations and
codec details were checked against the TP-7 Android companion 1.1.4, build 54,
arm64, alongside device captures. Package SHA-256:
`7a859b21a11f332be8deac1d80318eca026a6d216c5fe99c9935cef478db78ec`.
The package and generated dumps are not distributed in this repository.

Relevant method locations in that version:

| Component | RVA | Evidence |
| --- | --- | --- |
| `TeMidiBleService..ctor` | `0xCAA750` | Companion service/characteristic UUIDs |
| `TeMidiOverBleSysexSendBuffer.SetData` | `0xCBA2A4` | Packet framing |
| `OnCharacteristicValueChanged` | `0xCA9E54` | MIDI/audio demultiplexing |
| `EnterFileTransfer` / `RequestAudio` | `0xCAD560` / `0xCAD7C4` | File path and complete-file request |
| `Tp7NewRecorderService.SetPosition` | `0xCADB48` | Millisecond seek command |
| `TeArguments.Add(uint)` | `0xCEC5A8` | LE uint serialization |
| `libGroAudio.so:dvi_adpcm_decode` | `0x4458` | ADPCM block layout and sample decoding |

`libGroAudio.so` SHA-256:
`65d80ec3fe9807255f48fe528bc97ecb26348a2e03d506b6d685c2f60675347e`.
For device use, consult the [official TP-7 guide](https://teenage.engineering/guides/tp-7)
and [companion listing](https://play.google.com/store/apps/details?id=com.teenageengineering.tp7).
