#!/usr/bin/env python3
"""
TP-7 MIDI Explorer / Signal Sender
==================================

Exploration script for TP-7 MIDI control (tested with Traktor integration).

Setup:
    1) Put TP-7 in Controller/MIDI mode
    2) Connect TP-7 to Mac via USB
    3) Run this script or import as module

Requirements:
    pip install mido python-rtmidi

Findings & Notes (beyond official spec):
-----------------------------------------
CC 7 (Mix Volume):
    - Values < 16: no sound
    - Value 17+: full sound
    - Higher values may produce strange noisy artifacts

CC 17 (Loop):
    - 0 = Loop Exit
    - 1 = Loop Start
    - 2 = Loop Stop

CC 14 (Rec):
    - 127 = Move to Rec (on)
    - 0 = Move to Rec (off)

CC 16 (Cue Rec Mode):
    - Enable cue rec mode, then send Note On/Off to record cue marker
    - Note range: 0 (C#1) to 127 (G9)
    - When recalling a cue (Note On/Off outside cue rec mode):
      Runs playback with current speed enabled (speed controlled by pitch bend)
      If forward is enabled, it's added to playback speed like delta from center 64

CC 18 (FFwd/Rew):
    - 64 = Stop
    - 68 = Play forward x1
    - 60 = Play reverse x1
    - 0 = Super fast reverse
    - 127 = Super fast forward
"""

import time

# --- Install dependencies if missing ---
try:
    import mido
    from mido import Message
except ImportError:
    import sys
    import subprocess
    subprocess.check_call([sys.executable, "-m", "pip", "install", "-q", "mido", "python-rtmidi"])
    import mido
    from mido import Message


# =============================================================================
# MIDI Port Management
# =============================================================================

def list_midi_outputs():
    """List all available MIDI output ports."""
    outs = mido.get_output_names()
    print("MIDI Output Ports:")
    for i, n in enumerate(outs):
        print(f"  [{i}] {n}")
    return outs


def open_tp7_output(name_hint="TP-7", index=None):
    """
    Open TP-7 MIDI out by substring match (name_hint) or by explicit index.

    Args:
        name_hint: Substring to match in port name (default: "TP-7")
        index: Explicit port index (overrides name_hint if provided)

    Returns:
        mido output port
    """
    outs = mido.get_output_names()
    if not outs:
        raise RuntimeError("No MIDI output ports found. Is TP-7 connected and in MIDI mode?")

    if index is not None:
        port_name = outs[index]
        print("Opening:", port_name)
        return mido.open_output(port_name)

    # Try substring match
    matches = [n for n in outs if name_hint.lower() in n.lower()]
    if not matches:
        raise RuntimeError(f'No MIDI output contains "{name_hint}". See list above and pass index=...')

    port_name = matches[0]
    print("Opening:", port_name)
    return mido.open_output(port_name)


# =============================================================================
# Low-Level MIDI Helpers
# =============================================================================

def ch(ch1_to_16: int) -> int:
    """Convert 1..16 (human) to mido's 0..15 (internal)."""
    if not (1 <= ch1_to_16 <= 16):
        raise ValueError("MIDI channel must be 1..16")
    return ch1_to_16 - 1


def clamp(v, lo, hi):
    """Clamp value to range [lo, hi]."""
    return max(lo, min(hi, v))


def onoff(v: bool) -> int:
    """TP-7 on/off encoding: 0-63 = off, 64-127 = on."""
    return 127 if v else 0


def twos_complement_7bit(rel: int) -> int:
    """
    Relative two's complement mapping for -64..+63 into 0..127.
    Scheme: 0..63 = +0..+63, 64..127 = -64..-1
    """
    rel = int(clamp(rel, -64, 63))
    return rel & 0x7F


def send_cc(outport, cc: int, value: int, channel: int = 1):
    """Send a Control Change message."""
    msg = Message("control_change", channel=ch(channel), control=int(cc), value=value)
    outport.send(msg)
    return msg


def send_note(outport, note: int, velocity: int = 100, channel: int = 1, duration: float = 0.05):
    """
    Send Note On then Note Off (TP-7 uses Note On/Off for cue markers).

    Args:
        note: MIDI note number 0-127
        velocity: Note velocity 0-127
        channel: MIDI channel 1-16
        duration: Time between Note On and Note Off
    """
    note = int(clamp(note, 0, 127))
    velocity = int(clamp(velocity, 0, 127))
    on = Message("note_on", channel=ch(channel), note=note, velocity=velocity)
    off = Message("note_off", channel=ch(channel), note=note, velocity=0)
    outport.send(on)
    time.sleep(duration)
    outport.send(off)
    return (on, off)


def send_pitchbend(outport, value: int, channel: int = 1):
    """
    Send pitch bend message.

    Args:
        value: Pitch bend value -8192..+8191
        channel: MIDI channel 1-16
    """
    value = int(clamp(value, -8192, 8191))
    msg = Message("pitchwheel", channel=ch(channel), pitch=value)
    outport.send(msg)
    return msg


def send_rel_cc(outport, cc: int, rel: int, channel: int = 1):
    """Send a relative CC value using 7-bit two's complement (-64..+63)."""
    return send_cc(outport, cc, twos_complement_7bit(rel), channel=channel)


# =============================================================================
# TP-7 Specific Functions (based on MIDI spec + findings)
# =============================================================================

class TP7Controller:
    """High-level controller for TP-7 MIDI functions."""

    def __init__(self, outport):
        self.outport = outport

    def cue_marker(self, note_number: int, velocity: int = 100):
        """
        Send a cue marker (Note On/Off).

        Note range: 0 (C#1) to 127 (G9)
        """
        return send_note(self.outport, note_number, velocity=velocity, channel=1)

    def playback_speed(self, pitch: int):
        """
        Control playback speed via pitch bend.

        Args:
            pitch: -8192 to +8191
        """
        return send_pitchbend(self.outport, pitch, channel=1)

    def mix_volume(self, channel_1_to_6: int, value_0_to_127: int):
        """
        Set mix volume for a channel.

        Note: Values < 16 produce no sound, 17+ is full sound.
        Higher values may produce artifacts.
        """
        return send_cc(self.outport, 7, value_0_to_127, channel=channel_1_to_6)

    def input_gain(self, channel_1_to_3: int, value_0_to_127: int):
        """Set input gain for channels 1-3."""
        return send_cc(self.outport, 9, value_0_to_127, channel=channel_1_to_3)

    def rec(self, on: bool):
        """
        Toggle record mode.

        Args:
            on: True = arm recording, False = disarm
        """
        return send_cc(self.outport, 14, onoff(on), channel=1)

    def cue_rec_mode(self, on: bool):
        """
        Toggle cue recording mode.

        Enable this, then send cue_marker() to record a cue point.
        """
        return send_cc(self.outport, 16, onoff(on), channel=1)

    def loop_mode(self, mode: int):
        """
        Set loop mode.

        Args:
            mode: 0 = loop off/exit, 1 = loop start/in, 2 = loop stop/out
        """
        return send_cc(self.outport, 17, int(clamp(mode, 0, 2)), channel=1)

    def ffwd_rew(self, value: int):
        """
        Control fast forward / rewind.

        Absolute values (not relative two's complement):
            64 = Stop
            68 = Play forward x1
            60 = Play reverse x1
            0 = Super fast reverse
            127 = Super fast forward
        """
        return send_cc(self.outport, 18, int(clamp(value, 0, 127)), channel=1)

    def ffwd_rew_relative(self, rel: int):
        """
        Control fast forward / rewind with relative value.

        Args:
            rel: -64 to +63 (negative = rewind, positive = forward)
        """
        return send_rel_cc(self.outport, 18, rel, channel=1)

    def mix_mute(self, channel_1_to_6: int, on: bool):
        """Mute/unmute a mix channel."""
        return send_cc(self.outport, 120, onoff(on), channel=channel_1_to_6)

    def stop(self):
        """Stop playback."""
        return self.ffwd_rew(64)

    def play_forward(self):
        """Play forward at normal speed."""
        return self.ffwd_rew(68)

    def play_reverse(self):
        """Play in reverse at normal speed."""
        return self.ffwd_rew(60)


# =============================================================================
# Standalone convenience functions (for quick testing)
# =============================================================================

# Global outport reference for standalone functions
_outport = None


def _get_outport():
    global _outport
    if _outport is None:
        raise RuntimeError("No output port open. Call connect_tp7() first.")
    return _outport


def connect_tp7(name_hint="TP-7", index=None):
    """Connect to TP-7 and return a controller instance."""
    global _outport
    list_midi_outputs()
    _outport = open_tp7_output(name_hint=name_hint, index=index)
    return TP7Controller(_outport)


# Standalone function wrappers
def tp7_cue_marker(note_number: int, velocity: int = 100):
    return send_note(_get_outport(), note_number, velocity=velocity, channel=1)

def tp7_playback_speed(pitch: int):
    return send_pitchbend(_get_outport(), pitch, channel=1)

def tp7_mix_volume(channel_1_to_6: int, value_0_to_127: int):
    return send_cc(_get_outport(), 7, value_0_to_127, channel=channel_1_to_6)

def tp7_input_gain(channel_1_to_3: int, value_0_to_127: int):
    return send_cc(_get_outport(), 9, value_0_to_127, channel=channel_1_to_3)

def tp7_rec(on: bool):
    return send_cc(_get_outport(), 14, onoff(on), channel=1)

def tp7_cue_rec_mode(on: bool):
    return send_cc(_get_outport(), 16, onoff(on), channel=1)

def tp7_loop_mode(mode: int):
    return send_cc(_get_outport(), 17, int(clamp(mode, 0, 2)), channel=1)

def tp7_ffwd_rew(value: int):
    return send_cc(_get_outport(), 18, int(clamp(value, 0, 127)), channel=1)

def tp7_mix_mute(channel_1_to_6: int, on: bool):
    return send_cc(_get_outport(), 120, onoff(on), channel=channel_1_to_6)


# =============================================================================
# Main
# =============================================================================

if __name__ == "__main__":
    print(__doc__)
    print("\n" + "=" * 60)
    print("Interactive Mode")
    print("=" * 60 + "\n")

    # List available ports
    outs = list_midi_outputs()

    if not outs:
        print("\nNo MIDI outputs found. Connect TP-7 and try again.")
    else:
        print("\nTo connect, use:")
        print('  tp7 = connect_tp7()           # Auto-detect TP-7')
        print('  tp7 = connect_tp7(index=N)    # Use port index N')
        print("\nThen use tp7.* methods or tp7_*() standalone functions.")
        print("\nExample:")
        print("  tp7.stop()")
        print("  tp7.play_forward()")
        print("  tp7.loop_mode(1)  # Start loop")
        print("  tp7.cue_marker(60)")
