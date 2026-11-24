# TP-7 MIDI Specification

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
| CC 7 | 0-127 | 1-6 | Mix volume per stereo track |
| CC 9 | 0-127 | 1-3 | Input gain per channel (0-42dB) |
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

#### Normal Mode (Stopped)

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

#### Playback Mode (After Play or Cue trigger)

**⚠️ WARNING: Behavior changes completely during ANY playback!**

This applies when:
- Playing via physical Play button
- Playing via cue trigger (Note On/Off)
- Any active playback state

| Value | Function |
|-------|----------|
| 0 | Maximum reverse speed |
| 1-59 | Reverse (speed varies) |
| 60 | Slowest reverse |
| **~60.5** | **STOP POINT** (between 60-61, requires pitch +708) |
| 61 | Slowest forward |
| 62-126 | Forward (speed varies) |
| 127 | Maximum forward speed |

**Key Differences in Playback Mode:**
- ❌ **No stop at 64** - value 64 no longer stops playback
- ❌ **No stop position on CC18 alone** - stop point is BETWEEN 60 and 61
- ✅ **To stop:** Set CC18=60 AND Pitch Bend=+708 (compensation value)
- Speed becomes relative, not absolute
- Use Pitch Bend for fine speed control

---

### Note On/Off - Cue Markers

**⚠️ REQUIRED:** You must enable **MIDI-CUE** in TP-7 settings for cue markers to work via MIDI!

| Mode | Note On/Off Behavior |
|------|---------------------|
| Cue Rec Mode OFF (CC16=0) | Triggers/recalls cue at that note position |
| Cue Rec Mode ON (CC16=127) | Records a cue marker at current position |

**Cue Range:** 0 (C#1) to 127 (G9)

**⚠️ No MIDI way to clear cue markers!** To clear cues on TP-7, you must change the track manually on the device.

---

## Speed Control System (3 INDEPENDENT CONTROLS!)

TP-7 has **THREE separate speed multipliers**:

### 1. SPD on TP-7 Screen
- The speed value shown on TP-7's display
- **⚠️ NO MIDI ACCESS!** Cannot be controlled or read via MIDI
- Affects playback when playing

### 2. SPD (Pitch Bend) - Internal MIDI Speed Multiplier
- **Hidden internal speed multiplier** via MIDI
- **Only applies during playback** (no effect when stopped)
- **NOT visible on TP-7 display!** SPD indicator remains unchanged
- Controlled via MIDI Pitch Bend message

**⚠️ BUG:** The Pitch Bend speed multiplier and SPD on screen SHOULD be connected (same control), but they are completely separate. This is likely a firmware bug - the internal MIDI speed should update the SPD display, but it doesn't.

### 3. Rocker (CC 18) - Physical Rocker Emulation
- **Emulates the physical rocker** on TP-7
- **Works with AND without Play state** (moves tape even when stopped!)
- Values 0-127 control direction and speed (see CC18 section above)
- **NOT the SPD on screen** - separate control!
- When stopped: Only rocker affects tape movement
- When playing: Multiplies with other speed controls



**Range:** -8192 to +8191

**Speed Formula (asymmetric):**
- Negative: `multiplier = 1 + (pitch/8192) × 0.75` → range x0.25 to x1
- Positive: `multiplier = 1 + (pitch/8192)` → range x1 to x2

| Pitch | Multiplier | Effect |
|-------|------------|--------|
| -8192 | x0.25 | Quarter speed (slowest) |
| -5461 | x0.50 | Half speed |
| 0 | x1.00 | Normal speed |
| +708 | x1.09 | **Stop compensation for CC18=60** |
| +4096 | x1.50 | |
| +8191 | x2.00 | Double speed (fastest) |

### Speed Calculation

**When stopped:**
```
Tape movement = Rocker (CC18) only
```

**When playing:**
```
Final speed = SPD (screen) × Rocker (CC18) × Pitch Bend
```

### BPM Matching and Precision

The browser's **Match BPM** feature uses the experimental asymmetric mapping above.
Teenage Engineering documents Pitch Bend for playback speed but does **not** publish
this curve. Hardware validation is still required; numerical accuracy does not
establish accuracy of the physical playback speed.

With on-device SPD at unity, external sync off and the rocker released during
native playback, let `r = targetBpm / sourceBpm`:

```
r < 1: idealPitch = (r - 1) × 32768 / 3
r ≥ 1: idealPitch = (r - 1) × 8192
```

Choose the nearest integer pitch. Exact half-step ties choose the pitch closer to
zero. Input decimals, division and rounding use BigInt fractions, so no rounded
display value feeds back into the calculation. Each Apply is absolute relative to
the source BPM, not relative to the previously applied pitch. The source must be
the original track BPM, not an already speed-adjusted BPM.

The positive endpoint is **8191**, giving **1.9998779296875×**, not exactly 2×.
The negative endpoint is exactly **0.25×**. Out-of-range requests are rejected.
Within the range, the maximum quantization error is half a step:

- Slower than unity: `sourceBpm × 3 / 65536` BPM.
- Faster than unity: `sourceBpm / 16384` BPM.

Apply sends `[0xB0, 18, 64]` followed by the 14-bit Pitch Bend, as one USB send or
one BLE packet with timestamps for each message. This releases the rocker for
native playback and avoids the application's unrelated +708 stop compensation.
It does not start native playback or read/reset the device's on-screen SPD.
“Immediate” means no software ramp or scheduled correction; connection latency
and firmware processing time still apply. There is no device acknowledgement.

The BPM preview reports the result of this mapping and its signed quantization
error, not a measured tempo. Neither a zero mathematical error nor receipt of a
MIDI clock proves that the audio plays at that BPM. The app does not infer a
track's exact metadata from clock timing.

Stored BPM can be read from a user-selected **RIFF/WAVE ACID** chunk (little-endian
float32 at payload offset 20). The reader skips audio data, checks chunk boundaries
and padding, and rejects conflicting metadata. Missing/invalid BPM requires manual
input. Other file formats, including RF64 and MP3, currently require manual input.

### Stop Point During Playback

**To stop tape during playback:**
- Set CC18 = 60 (slowest reverse)
- Set Pitch Bend = +708 (compensation)
- This results in effective 0 speed (stop point between CC18 60-61)

The constant **+708** is the pitch bend value needed to compensate for CC18=60's reverse speed and achieve standstill.

---

## State Persistence Warning

**The standard MIDI interface has no documented state queries.** Vendor SysEx
replies exist; see [the separate companion-protocol investigation](docs/REMOTE_PROTOCOL.md).
Those replies do not establish support for reading or selecting existing file cues.

This means:
- You cannot query current transport state
- You cannot query loop state
- You cannot query which cues are set
- After reconnection, UI state may not match device state

**Important:** The "Outgoing MIDI Messages" (CC 20-27, wheel, rocker) are only sent when TP-7 is in **Controller Mode** - which is a different mode than when receiving MIDI commands. You cannot simultaneously control the TP-7 AND receive its button press events.

All states in control software are LOCAL ONLY and may become out of sync if the device is controlled externally or via physical buttons.

---

## Diagram: CC18 Behavior

```
NORMAL MODE (Stopped):
    0 ←←←←← 60 ←← 64 →→ 68 →→→→→ 127
    fast   rev  STOP  play    fast
    rev    x1         x1      fwd

PLAYBACK MODE:
    0 ←←←←← 60 | 61 →→→→→ 127
    fast   slow slow    fast
    rev    rev  fwd     fwd
              ↑
      STOP = CC18:60 + Pitch:+708
```

---

## Track Mixer (CC 7 / CC 120)

### 6 Stereo Tracks

TP-7 has **6 stereo tracks**, each controlled via MIDI channel 1-6:

| MIDI Channel | Track |
|--------------|-------|
| 1 | Track 1 (stereo) |
| 2 | Track 2 (stereo) |
| 3 | Track 3 (stereo) |
| 4 | Track 4 (stereo) |
| 5 | Track 5 (stereo) |
| 6 | Track 6 (stereo) |

### USB vs Internal Capacity

- **USB Output:** Only tracks 1-3 are output via USB (what you see in a DAW)
- **Internal Mixing:** TP-7 can mix all 6 stereo tracks internally

### ⚠️ Mixer Reset Behavior

**Mixer levels and mutes reset when track is changed via cue or loop!**

When a cue is triggered or loop cycles to a different track:
- All volume levels reset to default (100%)
- All mute states are cleared

This is a known limitation - there's no way to prevent this via MIDI.

---

## Summary of Gotchas

1. **CC17 (Loop)** is a state machine - must set In before Out, can only exit with Off
2. **CC18 (Transport)** has TWO completely different modes (stopped vs playing)
3. **Playback mode** removes the stop position from CC18 - need pitch compensation
4. **Stop during playback** requires CC18=60 + Pitch Bend=+708
5. **No standard state queries** - The standard control UI has no feedback; vendor SysEx is a separate experimental interface
6. **Controller Mode is separate** - TP-7 only sends button events in Controller Mode, which is mutually exclusive with receiving commands
7. **MIDI-CUE setting required** - Must enable MIDI-CUE in TP-7 settings for cue markers to work
8. **3 speed controls** - SPD (no MIDI access!), Rocker (CC18), Pitch Bend - all multiply during playback
9. **SPD/Pitch Bend disconnect (BUG)** - Internal MIDI speed (Pitch Bend) should update SPD on screen but doesn't - they should be the same control
10. **Recording via MIDI is useless** - CC14 arms recording BUT you can't control playback in record mode via MIDI (only rocker emulation). Use physical controls for recording.
11. **Mixer resets on track change** - Volume levels and mutes reset when track is changed via cue or loop trigger
