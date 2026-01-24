# TP-7 MIDI Specification - Experimental Findings

> **Firmware Version:** 1.1.11 (2026.01.24)
>
> This document contains experimental findings beyond the official MIDI spec.
> The official spec is incomplete/unclear in several areas.

## Official MIDI Reference

### Outgoing MIDI Messages (Controller Mode)

When TP-7 is in Controller/MIDI mode, it sends these messages when you interact with the device:

| Control | CC | Channel | Range | Notes |
|---------|-----|---------|-------|-------|
| Up | 20 | 1 | 0-127 | Button press |
| Down | 21 | 1 | 0-127 | Button press |
| Rec | 22 | 1 | 0-127 | Button press |
| Play | 23 | 1 | 0-127 | Button press |
| Stop | 24 | 1 | 0-127 | Button press |
| Left | 25 | 1 | 0-127 | Button press |
| Right | 26 | 1 | 0-127 | Button press |
| Memo | 27 | 1 | 0-127 | Button press |
| Wheel | 30 | 1 | -64 to +63 | Relative, two's complement |
| Rocker | Pitch Bend | 1 | ±8192 | Pitch bend message |

### Incoming MIDI Control Messages

Messages you can send TO the TP-7 to control it:

| Message | Range | Channel | Function |
|---------|-------|---------|----------|
| Note On | 0-127 | any | Cue marker trigger |
| Note Off | 0-127 | any | Cue marker trigger |
| Pitch Bend | ±8192 | any | Playback speed modifier |
| CC 7 | 0-127 | 1-6 | Mix volume per channel |
| CC 9 | 0-127 | 1-3 | Input gain per channel |
| CC 14 | on/off | any | Arm recording |
| CC 16 | on/off | any | Cue rec mode enable |
| CC 17 | 0-2 | any | Loop control |
| CC 18 | 0-127 | any | FFwd/Rew/Play/Stop |
| CC 120 | on/off | 1-6 | Mix mute per channel |

### On/Off Encoding

- **0-63** = Off
- **64-127** = On

---

## Experimental Findings

### CC 7 - Mix Volume (WEIRD BEHAVIOR)

| Value | Behavior |
|-------|----------|
| 0-16 | **No sound at all** |
| 17+ | Full sound (no gradual fade) |
| High values | May produce strange noisy artifacts |

**Conclusion:** CC 7 does NOT work as a normal volume fader. It seems more like a threshold switch.

---

### CC 17 - Loop Control (STATE MACHINE)

Loop control is a **state machine**, not simple on/off:

| Value | Action | Next Valid Actions |
|-------|--------|-------------------|
| 0 | Exit/Clear loop | Can set In (1) |
| 1 | Set loop IN point | Can set Out (2) or Exit (0) |
| 2 | Set loop OUT point | Can only Exit (0) |

**Important:**
- You MUST set In (1) before Out (2)
- Sending Out (2) without In (1) first does nothing
- Once loop is active (In+Out set), you can ONLY exit with Off (0)
- You CANNOT change In/Out points while loop is active

---

### CC 18 - Transport Control (TWO MODES!)

This is the most complex and poorly documented feature.

#### Normal Mode (Default)

| Value | Function |
|-------|----------|
| 0 | Super fast rewind |
| 1-59 | Rewind (speed varies) |
| 60 | Rewind x1 speed |
| 61-63 | Slow rewind |
| **64** | **STOP** |
| 65-67 | Slow forward |
| 68 | Play forward x1 speed |
| 69-126 | Forward (speed varies) |
| 127 | Super fast forward |

#### Cue Playback Mode (After triggering cue via Note On/Off)

**⚠️ WARNING: Completely different behavior!**

| Value | Function |
|-------|----------|
| 0 | Maximum reverse speed |
| 1-59 | Reverse (speed varies) |
| 60 | Slowest reverse (~-1x) |
| **NO STOP** | Center point shifts! |
| 61 | Slowest forward (~+1x) |
| 62-126 | Forward (speed varies) |
| 127 | Maximum forward speed |

**Key Differences in Cue Mode:**
- ❌ **No stop position** - 64 no longer stops playback
- The center shifts so 60/61 are the slowest speeds
- Speed becomes relative, not absolute
- Use Pitch Bend for fine speed control instead
- Trigger another cue to change playback position

---

### Note On/Off - Cue Markers

| Mode | Note On/Off Behavior |
|------|---------------------|
| Cue Rec Mode OFF (CC16=0) | Triggers/recalls cue at that note position |
| Cue Rec Mode ON (CC16=127) | Records a cue marker at current position |

**Cue Range:** 0 (C#1) to 127 (G9)

When recalling a cue:
- Playback starts from that cue point
- Speed is controlled by Pitch Bend
- CC18 becomes relative speed (see above)
- If CC18 forward is enabled, it adds to playback speed like delta from center

---

### Pitch Bend - Speed Modifier

| Context | Behavior |
|---------|----------|
| Normal playback | Modifies playback speed |
| Cue playback | Primary speed control (since CC18 has no stop) |

**Range:** -8192 to +8191
- Negative = slower/reverse
- Zero = normal speed
- Positive = faster

**⚠️ Important:** Pitch bend changes are NOT visible on TP-7 display! The speed indicator on the device remains unchanged even when pitch bend is applied via MIDI.

**TODO:** Test if there's a specific pitch bend value that can actually stop playback from cue mode (effectively becoming a "stop" command)

---

## Monitoring TP-7 State via MIDI Input

While you cannot *query* the TP-7 state, you CAN monitor button presses by listening to MIDI input!

### Outgoing Messages from TP-7 (Controller Mode)

When buttons are pressed on the device, TP-7 sends:

| Control | CC | Value | Notes |
|---------|-----|-------|-------|
| Up | 20 | 0-127 | 64+ = pressed |
| Down | 21 | 0-127 | 64+ = pressed |
| Rec | 22 | 0-127 | 64+ = pressed |
| Play | 23 | 0-127 | 64+ = pressed |
| Stop | 24 | 0-127 | 64+ = pressed |
| Left | 25 | 0-127 | 64+ = pressed |
| Right | 26 | 0-127 | 64+ = pressed |
| Memo | 27 | 0-127 | 64+ = pressed |
| Wheel | 30 | -64 to +63 | Relative, two's complement |
| Rocker | Pitch Bend | ±8192 | Continuous |

**Use Case:** Connect to TP-7's MIDI input port to monitor user interactions and sync your UI accordingly.

---

## State Persistence Warning

**TP-7 does NOT report its state on request.**

This means:
- You cannot query current transport state
- You cannot query loop state
- You cannot query which cues are set
- After reconnection, UI state may not match device state

**However:** You CAN monitor button presses via MIDI input to stay in sync when the user interacts with the physical device.

All states in control software are LOCAL ONLY and may become out of sync if the device is controlled externally.

---

## Python Code Example

```python
import mido
from mido import Message

# Open TP-7
port = mido.open_output('TP-7')

# Transport control (normal mode)
def stop():
    port.send(Message('control_change', control=18, value=64))

def play():
    port.send(Message('control_change', control=18, value=68))

def rewind():
    port.send(Message('control_change', control=18, value=60))

# Loop control (must be in sequence!)
def loop_in():
    port.send(Message('control_change', control=17, value=1))

def loop_out():
    port.send(Message('control_change', control=17, value=2))

def loop_off():
    port.send(Message('control_change', control=17, value=0))

# Cue markers
def enable_cue_rec():
    port.send(Message('control_change', control=16, value=127))

def disable_cue_rec():
    port.send(Message('control_change', control=16, value=0))

def trigger_cue(note):
    port.send(Message('note_on', note=note, velocity=100))
    time.sleep(0.05)
    port.send(Message('note_off', note=note, velocity=0))

# Speed control in cue mode (use pitch bend!)
def set_speed(value):  # -8192 to 8191
    port.send(Message('pitchwheel', pitch=value))
```

---

## Diagram: CC18 Behavior

```
NORMAL MODE:
    0 ←←←←← 60 ←← 64 →→ 68 →→→→→ 127
    fast   rev  STOP  play    fast
    rev    x1         x1      fwd

CUE PLAYBACK MODE:
    0 ←←←←← 60 | 61 →→→→→ 127
    fast   slow slow    fast
    rev    rev  fwd     fwd
              ↑
         NO STOP!
```

---

## Summary of Gotchas

1. **CC7 (Volume)** doesn't work as expected - more like on/off at threshold 17
2. **CC17 (Loop)** is a state machine - must set In before Out, can only exit with Off
3. **CC18 (Transport)** has TWO completely different modes
4. **Cue playback** removes the stop position from CC18
5. **No state feedback** - TP-7 never reports its state via MIDI
6. **Pitch Bend** becomes essential for speed control during cue playback
