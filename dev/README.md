# Development

Technical setup for local development and testing.

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
