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

## Troubleshooting

### Browsers (READ THIS FIRST)

#### iOS (iPhone / iPad) limitations — why only Bluefy works
- **Safari on iOS does not support Web Bluetooth** (needed for Bluetooth control) and **does not support Web MIDI** (needed for USB control).
- **All “normal” iOS browsers** (Safari/Chrome/Edge/Firefox) are still limited by iOS and won’t work for TP7-MIDI Bluetooth/USB in the browser.
- **Bluefy** is the one iOS browser that provides **Web BLE (Web Bluetooth) support**, so it can connect to the TP-7 over **Bluetooth**.
- **USB/MIDI on iOS:** not possible in the browser (Web MIDI isn’t supported on iOS). Also, very old “Web MIDI browser” apps from ~2016 are outdated and won’t work for this.

#### Android — which browsers work?
Use a Chromium-based browser that supports **Web Bluetooth** (for Bluetooth) and **Web MIDI** (for USB):
- ✅ **Chrome**
- ✅ **Edge**
- ✅ **Samsung Internet**
- ✅ **Opera**
- ❌ **Firefox for Android** (no Web Bluetooth / Web MIDI for this use case)

If Bluetooth scanning finds **zero devices** on Android:
- Turn **Bluetooth ON**
- Turn **Location Services ON**
- Allow the browser “Nearby devices” / Bluetooth permissions (and Location permission if your Android version asks)

#### macOS / Windows / Linux — recommended browsers
- ✅ **Chrome or Edge** (best-tested)
- ✅ **Opera** (Chromium-based, usually fine)
- ⚠️ **Firefox (desktop):** USB/MIDI *may* work, but **Bluetooth won’t** (no Web Bluetooth)
- ⚠️ **Brave:** Web Bluetooth may be **disabled by default**. Use Chrome/Edge, or enable it:
  1. Open `brave://flags`
  2. Search **Bluetooth** / **Web Bluetooth**
  3. Enable the Web Bluetooth flag(s)
  4. Relaunch Brave

### Enable Bluetooth / MIDI permissions (Desktop + Android)

#### Bluetooth (Web Bluetooth)
- Web Bluetooth requires a **secure context**: HTTPS (or `localhost` for dev).
- Pressing **Connect** should open a **device picker**. If it doesn’t:
  - Check the site’s permissions (don’t “Block” Bluetooth for this site)
  - On **macOS**: System Settings → Privacy & Security → **Bluetooth** → allow your browser

#### USB (Web MIDI)
- Web MIDI also requires **HTTPS** (or `localhost`).
- When the browser asks for MIDI access, click **Allow**.
- If you previously blocked it: lock icon → **Site settings** → allow **MIDI devices** (wording may vary).

### Android + USB cable: TP-7 not showing up (only charging)
1. Use a USB-C cable/adapter that supports **data/OTG** (not charge-only).
2. Plug in the TP-7.
3. Pull down Android notifications → tap the **USB** notification (often says “Charging this device via USB”).
4. Select **MIDI** mode.
5. Reload the page → press **Connect** again → choose the TP-7 from the MIDI device list.

### Still stuck?
- Update the browser to the latest version.
- Close other tabs/apps that might already be connected to TP-7 via MIDI/Bluetooth.
- On Linux: some sandboxed Chromium builds (Snap/Flatpak) can’t see USB MIDI devices — try official Chrome or a non-sandboxed Chromium build.

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
