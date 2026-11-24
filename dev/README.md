# Development

Technical setup for local development and testing.

---

## Tests

The production app is still plain HTML/CSS/JS with no build step. Deploy the root
files together, including the tempo, local WAV cue reader, companion transfer, remote session
and cue/grid panel scripts, to GitHub Pages.

Install the pinned development dependencies with Node.js 20 or newer:

```sh
npm ci
npm test
npx playwright install chromium
npm run test:browser
```

`npm test` runs arithmetic, metadata, packet and codec tests. They cover every
representable pitch, exact half-step boundaries, an independent exhaustive
nearest-value check, invalid/out-of-range BPM, metadata corruption and skipping
large audio payloads. `npm run test:browser` uses simulated USB/BLE devices.
There are no runtime npm dependencies or production build step.

The GitHub Actions workflow runs both suites with Node.js 24 and Chromium on
pull requests and pushes. It needs only read access to repository contents.

Set `TP7_BROWSER_PATH` to an installed Chromium/Edge executable to use it instead
of Playwright's bundled browser. `TP7_SCREENSHOT_DIR` optionally saves desktop and
mobile screenshots. These tests cover MIDI packets, retries, disconnection,
cancellation of stale queued commands, reload/persistence, cue BPM loading and layout.
They never access a real MIDI device and do not validate TP-7's speed curve.
The remote-panel tests also simulate fragmented BLE SysEx, successful device
acknowledgements, opt-in listening, notification failure and session timeout.
They cover unsolicited companion notifications, position/file parsing, exact
millisecond seek encoding, failed seeks, and cancellation when the track changes.
They do not validate native cue navigation; see [REMOTE_PROTOCOL.md](../docs/REMOTE_PROTOCOL.md).
Prepared-cue tests also cover arbitrary Unicode filenames, automatic loading only
after confirmed Stop, one attempt per track selection, manual retry, cancellation
on track change, preference persistence, and real-position highlighting across
forward/backward jumps, stale notifications, EOF and page boundaries. These are
simulated transport checks. Cue loading and live highlighting have also been
checked on TP-7 1.1.11 with Bluefy. Additional tests cover cue-mode cancellation,
missing helpers, BPM auto-fill/manual precedence, and the optional grid remaining
unbuilt while hidden.

For a hardware check, use a known constant-BPM recording, native playback with
on-device SPD=1× and external clock sync disabled. Measure recorded output against
the predicted BPM at unity and several negative/positive pitches on the actual
firmware. The current mapping must be treated as experimental until validated.

---

## Local Testing

Web MIDI and Web Bluetooth require HTTPS. Self-signed certs don't work well with Safari (macOS/iOS). Use **mkcert** for proper local HTTPS.

### Quick Start (mkcert - recommended)

```bash
# Install mkcert
brew install mkcert

# Install local CA (requires password)
mkcert -install

# Generate certs (add your LAN IP for mobile testing)
mkcert -key-file key.pem -cert-file cert.pem localhost 127.0.0.1 ::1

# Start server
python3 dev/serve_https.py
```

Open https://localhost:8443

### Mobile Testing (iOS/Android)

To test on mobile devices, include your LAN IP in the certificate:

```bash
# Find your LAN IP
ipconfig getifaddr en0

# Generate cert with LAN IP (example: 192.168.1.100)
mkcert -key-file key.pem -cert-file cert.pem localhost 127.0.0.1 ::1 192.168.1.100
```

**For iOS Safari:**
1. Find mkcert CA: `mkcert -CAROOT`
2. AirDrop `rootCA.pem` to your iPhone
3. iPhone: Settings → Downloaded Profile → Install
4. iPhone: Settings → General → About → **Certificate Trust Settings** → Toggle ON for mkcert
5. Open `https://<your-lan-ip>:8443`

**For Android:**
- Chrome usually accepts the cert if mkcert CA is installed
- Or just accept the warning

### Alternative: openssl (basic, Safari won't trust it)

```bash
openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -days 365 -nodes -subj "/CN=localhost"
python3 dev/serve_https.py
```

Works in Chrome (click through warning), but Safari blocks it.

### Devcontainer

The `.devcontainer` config auto-generates certs and exposes port 8443. Use with VS Code or:

```bash
npm install -g @devcontainers/cli
devcontainer up --workspace-folder .
devcontainer exec --workspace-folder . python dev/serve_https.py
```

---

## Files in this folder

| File | Description |
|------|-------------|
| `serve_https.py` | Local HTTPS server for testing |
| `tp7_midi_explorer.py` | Python MIDI tool (CLI) |
| `cert.pem` / `key.pem` | SSL certificates for local dev |

---

## Python MIDI Explorer

Standalone Python tool for MIDI debugging.

```bash
# Install
pip install mido python-rtmidi

# Run
python3 tp7_midi_explorer.py
```

---

## MIDI Reference

### TP-7 Sends (Outgoing)

| Control | CC | Channel | Range |
|---------|-----|---------|-------|
| up | 20 | 1 | 0-127 |
| down | 21 | 1 | 0-127 |
| rec | 22 | 1 | 0-127 |
| play | 23 | 1 | 0-127 |
| stop | 24 | 1 | 0-127 |
| left | 25 | 1 | 0-127 |
| right | 26 | 1 | 0-127 |
| memo | 27 | 1 | 0-127 |
| wheel | 30 | 1 | -64 to +63 |
| rocker | pitch bend | 1 | +/- 8192 |

### TP-7 Receives (Incoming)

| Message | Range | Channel | Function |
|---------|-------|---------|----------|
| note on/off | 0-127 | - | cue marker |
| pitch bend | +/- 8192 | - | playback speed |
| cc 7 | 0-127 | 1-6 | mix volume |
| cc 9 | 0-127 | 1-3 | input gain |
| cc 14 | on/off | - | rec arm |
| cc 16 | on/off | - | cue rec mode |
| cc 17 | 0-2 | - | loop off/in/out |
| cc 18 | -64 to +63 | - | ffwd/rew |
| cc 120 | on/off | 1-6 | mix mute |

**on/off values:** 0-63 = off, 64-127 = on

See [MIDI_SPEC.md](../MIDI_SPEC.md) for full documentation.
