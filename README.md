# TP7-MIDI

Web app to control your **Teenage Engineering TP-7** field recorder via MIDI and Bluetooth.

Works on phones, tablets, and computers - right in your browser.

**Live App:** https://lucidyan.github.io/tp7-midi

---

## How to Use

1. Open the app in your browser
2. Connect your TP-7 via USB or Bluetooth
3. Tap "Connect" and select your device
4. Control playback, recording, cue points, loops, and more

---

## Documentation

| Document | Description |
|----------|-------------|
| [MANUAL.md](docs/MANUAL.md) | TP-7 manual (text version, screen reader friendly) |
| [FIRMWARE_CHANGELOG.md](docs/FIRMWARE_CHANGELOG.md) | Firmware updates history |
| [MIDI_SPEC.md](MIDI_SPEC.md) | MIDI commands reference |

---

## Official TP-7 Resources

- Manual: https://teenage.engineering/guides/tp-7
- Firmware: https://teenage.engineering/downloads/tp-7
- Product: https://teenage.engineering/products/tp-7

---

## Known Bugs & Limitations

These are TP-7 firmware limitations discovered through MIDI experimentation:

| Issue | Description |
|-------|-------------|
| **No state feedback** | TP-7 never reports its state via MIDI. You cannot query transport, loop, or cue states. UI may become out of sync after reconnection or physical interaction. |
| **Controller Mode is separate** | TP-7 only sends button events (CC 20-27) in Controller Mode, which is mutually exclusive with receiving MIDI commands. You cannot control AND receive events simultaneously. |
| **No stop during playback** | In playback mode (after Play or Cue trigger), CC18 value 64 no longer stops. Stop point shifts between 60-61. To stop: set CC18=60 AND Pitch Bend=+708. |
| **SPD/Pitch Bend disconnect** | The Pitch Bend speed multiplier and SPD on screen SHOULD be the same control, but they're completely separate. Pitch Bend changes are NOT visible on TP-7 display. Likely a firmware bug. |
| **Recording via MIDI is useless** | CC14 arms recording, but you can't control playback in record mode via MIDI (only rocker emulation works). Use physical controls for recording. |
| **No MIDI way to clear cues** | To clear cue markers on TP-7, you must change the track manually on the device. |
| **MIDI-CUE setting required** | You must enable MIDI-CUE in TP-7 settings for cue markers to work via MIDI. |
| **Loop is a state machine** | CC17 must follow sequence: Off(0) → In(1) → Out(2) → Off(0). Can't set Out without In first. Can't change points while loop is active. |

See [MIDI_SPEC.md](MIDI_SPEC.md) for full technical details.

---

**Last Updated:** 2026-01-24 | **Firmware:** 1.1.11

*Unofficial community project. TP-7 is a product of Teenage Engineering.*

[For developers](dev/)
