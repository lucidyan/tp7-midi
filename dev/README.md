# Development

Technical setup for local development and testing.

---

## Local Testing

WebMIDI requires HTTPS. To test locally:

### 1. Generate SSL Certificate

```bash
openssl req -x509 -newkey rsa:4096 -keyout key.pem -out cert.pem -days 365 -nodes -subj "/CN=localhost"
```

### 2. Start Local Server

```bash
python3 serve_https.py
```

### 3. Open in Browser

```
https://localhost:4443
```

Accept the self-signed certificate warning.

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
