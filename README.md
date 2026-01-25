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

This app uses **Web Bluetooth (BLE)** for wireless control and **Web MIDI** for USB control.
Browser support is uneven — check compatibility here:
- Web Bluetooth support table: https://caniuse.com/web-bluetooth
- Web MIDI support table: https://caniuse.com/midi
- Web Bluetooth docs (requirements + permissions): https://developer.mozilla.org/en-US/docs/Web/API/Web_Bluetooth_API
- Web MIDI docs (requirements + permissions): https://developer.mozilla.org/en-US/docs/Web/API/Web_MIDI_API

#### Quick compatibility (TP7-MIDI)
| Platform | Bluetooth (Web Bluetooth / BLE) | USB (Web MIDI) |
|---|---:|---:|
| **iOS (Safari/Chrome/Edge/Firefox)** | ❌ | ❌ |
| **iOS (Bluefy)** | ✅ (BLE only) | ❌ |
| **Android (Chrome/Edge/Samsung Internet/Opera)** | ✅ | ✅ |
| **Android (Firefox)** | ❌ | ❌ |
| **macOS / Windows / Linux (Chrome/Edge/Opera)** | ✅ | ✅ |
| **macOS / Windows / Linux (Firefox)** | ❌ | ✅ (desktop only) |
| **macOS / iOS (Safari)** | ❌ | ❌ |
| **Brave (desktop)** | ⚠️ *usually OFF by default* | ⚠️ *sometimes broken/disabled* |

---

#### iOS (iPhone / iPad) limitations — why only **Bluefy** works
- **Safari on iOS does not support Web Bluetooth** and **does not support Web MIDI**:
  - Web Bluetooth: https://caniuse.com/web-bluetooth
  - Web MIDI: https://caniuse.com/midi
- **All iOS browsers that are “Safari under the hood”** (Chrome/Edge/Firefox on iOS) inherit the same limitations.
- **Bluefy** is a special iOS browser that implements **Web BLE** so it can do **Bluetooth (BLE)** in-browser:
  - App Store: https://apps.apple.com/us/app/bluefy-web-ble-browser/id1492822055
- **USB/MIDI on iOS:** not possible in the browser (no Web MIDI support on iOS).

---

#### Android — which browsers work?
Use a Chromium-based browser with Web Bluetooth + Web MIDI support:
- ✅ **Chrome** (Bluetooth help: https://support.google.com/chrome/answer/6362090)
- ✅ **Microsoft Edge** (Bluetooth/USB help: https://support.microsoft.com/en-us/microsoft-edge/connect-a-website-to-a-bluetooth-or-usb-device-in-microsoft-edge-107ba8a4-60aa-0fd3-2d26-afd63d0964f4)
- ✅ **Samsung Internet** (Web Bluetooth docs: https://samsunginternet.github.io/docs/web-bluetooth)
- ✅ **Opera** (Web Bluetooth support: https://caniuse.com/web-bluetooth / Web MIDI support: https://caniuse.com/midi)
- ❌ **Firefox for Android** (no Web Bluetooth / no Web MIDI): https://caniuse.com/web-bluetooth / https://caniuse.com/midi

If Bluetooth scanning finds **zero devices** on Android:
- Turn **Bluetooth ON**
- Turn **Location Services ON** (BLE scanning is often gated behind Location on Android)
- Allow the browser **Nearby devices / Bluetooth** permission (and Location permission if asked)

---

#### macOS / Windows / Linux — recommended browsers
- ✅ **Chrome** (Web Bluetooth docs: https://developer.chrome.com/docs/capabilities/bluetooth)
- ✅ **Microsoft Edge** (Bluetooth/USB help: https://support.microsoft.com/en-us/microsoft-edge/connect-a-website-to-a-bluetooth-or-usb-device-in-microsoft-edge-107ba8a4-60aa-0fd3-2d26-afd63d0964f4)
- ✅ **Opera** (Web MIDI settings hint: `opera://settings/content/midiDevices`)
- ⚠️ **Firefox (desktop)**: **USB/MIDI can work**, **Bluetooth won’t**:
  - Web MIDI support: https://caniuse.com/midi
  - Web Bluetooth unsupported: https://caniuse.com/web-bluetooth
  - Firefox Web MIDI note (permission add-on): https://developer.mozilla.org/en-US/docs/Mozilla/Firefox/Releases/108
- ❌ **Safari (macOS)**: no Web Bluetooth + no Web MIDI:
  - https://caniuse.com/web-bluetooth
  - https://caniuse.com/midi

---

#### Brave notes (desktop)
Brave is Chromium-based but often disables “dangerous” device APIs by default.

**If Bluetooth doesn’t work in Brave:**
1. Open `brave://flags`
2. Search: **Web Bluetooth**
3. Enable it
4. Relaunch Brave  
(Example reports: https://community.brave.app/t/can-you-enable-web-bluetooth-api-in-brave/522553)

**If Brave says “MIDI devices not supported”:**
- Try **Chrome or Edge** first (Brave sometimes disables/breaks Web MIDI in some builds):
  - Example report: https://community.brave.app/t/midi-devices-not-supported/507756

---

### Permissions & feature enablement (Desktop + Android)

#### 1) HTTPS requirement (must-have)
Web Bluetooth and Web MIDI require a **secure context** (HTTPS), except `localhost` for dev:
- Web Bluetooth (MDN): https://developer.mozilla.org/en-US/docs/Web/API/Web_Bluetooth_API
- Web MIDI (MDN): https://developer.mozilla.org/en-US/docs/Web/API/Web_MIDI_API

#### 2) Bluetooth permission (Web Bluetooth)
**Chrome / Chromium browsers**
- Chrome help (Bluetooth site connect): https://support.google.com/chrome/answer/6362090
- Debug page (advanced): `chrome://bluetooth-internals` (Chrome docs mention it: https://developer.chrome.com/docs/capabilities/bluetooth)

**macOS system permission**
- If the browser is blocked at OS level: System Settings → Privacy & Security → **Bluetooth**
  - Apple guide: https://support.apple.com/guide/mac-help/change-privacy-security-settings-on-mac-mchl211c911f/mac

#### 3) MIDI permission (Web MIDI / USB)
**Chrome**
- MIDI permission help: https://support.google.com/chrome/answer/14871962
- Chrome change (permission prompt for all Web MIDI access): https://developer.chrome.com/blog/web-midi-permission-prompt

**Firefox (desktop)**
- Firefox may prompt you to install a **Site Permission Add-On** when a site requests MIDI:
  - https://developer.mozilla.org/en-US/docs/Mozilla/Firefox/Releases/108

---

### Android + USB cable: TP-7 not showing up (only charging)
On Android, you must switch the USB mode to **MIDI**:

1. Use a **data/OTG-capable** USB-C cable/adapter (not charge-only).
2. Plug in the TP-7.
3. Pull down notifications → tap **USB for…**
4. Select **MIDI**
5. Reload the page → press **Connect** → choose the TP-7 from the MIDI device list.

Official Android docs mention this exact flow (“USB for…” → MIDI):
- https://source.android.com/docs/core/audio/midi

Tip: If you want it to default to MIDI every time:
- Settings → Developer options → Networking → **Select USB Configuration** → **MIDI**
  (also documented here: https://source.android.com/docs/core/audio/midi)

---

### Still stuck?
- Update your browser to the latest version.
- Close other tabs/apps that might already be connected to TP-7 via MIDI/Bluetooth.
- Linux note: sandboxed browser packages (Snap/Flatpak) can block USB/Bluetooth access — try official Chrome/Edge, or adjust sandbox permissions.


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
