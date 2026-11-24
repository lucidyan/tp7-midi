// =====================================================================
// TP-7 MIDI Controller - Web MIDI + BLE MIDI Implementation
// =====================================================================

let midiOutput = null;
let midiInput = null;
let midiAccess = null;

// BLE MIDI
const BLE_MIDI_SERVICE = '03b80e5a-ede8-4b33-a751-6ce34ec4c700';
const BLE_MIDI_CHARACTERISTIC = '7772e5db-3868-4112-a1a9-f2669d106bf3';
let bleDevice = null;
let bleMidiCharacteristic = null;
let connectionType = null; // 'usb' or 'ble'
let bleWriteQueue = Promise.resolve();
let tempoRevision = 0;
let tempoPending = false;
let tempoLastSent = null;
let tempoFileRevision = 0;

// =====================================================================
// Constants
// =====================================================================

const MIDI = {
    MIN: 0,
    MAX: 127,
    CENTER: 64,
    ON: 127,
    OFF: 0,
    PITCH_OFFSET: 8192,  // Added to signed value to get unsigned MIDI pitch bend
    PITCH_MIN: -8192,
    PITCH_MAX: 8191,
};

const TP7 = {
    // CC Numbers
    CC_VOLUME: 7,
    CC_GAIN: 9,
    CC_REC_ARM: 14,
    CC_CUE_REC: 16,
    CC_LOOP: 17,
    CC_TRANSPORT: 18,
    CC_MUTE: 120,

    // Tracks
    STEREO_TRACKS: 6,
    INPUT_CHANNELS: 3,

    // Gain
    MAX_GAIN_DB: 42,

    // Transport/Rocker speeds
    SPEED_STOP: 64,
    SPEED_REW_1X: 60,
    SPEED_FWD_1X: 68,
    SPEED_MAX_REW: 0,
    SPEED_MAX_FWD: 127,

    // Playback stop compensation
    STOP_COMPENSATION_PITCH: 708,

    // Cues
    CUE_MIN: 8,
    CUE_MAX: 128,
    CUE_STEP: 8,
};

// State
const state = {
    transport: TP7.SPEED_STOP,
    loopState: 'off',
    cueRecMode: false,
    cues: new Set(),
    cueCount: TP7.CUE_MIN,
};

// Check Web MIDI support (for USB tab)
if (!navigator.requestMIDIAccess) {
    // Don't hide app - BLE might still work
    document.getElementById('dismiss-midi-not-supported').style.display = 'block';
}

// Check Web Bluetooth support (for BLE tab)
if (!navigator.bluetooth) {
    document.getElementById('ble-not-supported').style.display = 'block';
}

// =====================================================================
// MIDI Utilities (USB + BLE)
// =====================================================================

function isMidiConnected() {
    return (connectionType === 'usb' && midiOutput && midiOutput.state !== 'disconnected') ||
        (connectionType === 'ble' && bleMidiCharacteristic && bleDevice?.gatt.connected);
}

// Send a batch immediately on USB, or in one ordered BLE write. The Promise
// confirms delivery to the browser/transport, not a TP-7 state acknowledgement.
function transmitMidiBatch(messages, isCurrent = () => true) {
    if (window.tp7CompanionBusy) return Promise.reject(new Error('Wait for the cue file transfer to finish.'));
    if (connectionType === 'ble' && bleMidiCharacteristic) {
        const characteristic = bleMidiCharacteristic;
        const write = bleWriteQueue.then(async () => {
            if (window.tp7CompanionBusy) throw new Error('Cue file transfer is active.');
            if (connectionType !== 'ble' || bleMidiCharacteristic !== characteristic || !isMidiConnected()) {
                throw new Error('Bluetooth disconnected. Reconnect and apply again.');
            }
            if (!isCurrent()) throw new Error('Tempo settings changed before sending. Apply again.');
            const timestamp = Math.floor(performance.now()) & 0x1FFF;
            const header = 0x80 | ((timestamp >> 7) & 0x3F);
            const timestampLow = 0x80 | (timestamp & 0x7F);
            const packet = new Uint8Array([header, ...messages.flatMap(bytes => [timestampLow, ...bytes])]);
            await characteristic.writeValueWithoutResponse(packet);
        });
        // Keep later writes usable after a failure; callers still receive it.
        bleWriteQueue = write.catch(() => {});
        return write;
    }
    if (connectionType === 'usb' && isMidiConnected()) {
        try {
            if (!isCurrent()) throw new Error('Tempo settings changed. Apply again.');
            midiOutput.send(messages.flat());
            return Promise.resolve();
        } catch (error) {
            return Promise.reject(error);
        }
    }
    return Promise.reject(new Error('Connect TP-7 before applying tempo.'));
}

// Existing controls retain their synchronous availability check.
function sendMidi(bytes) {
    if (!isMidiConnected()) return false;
    transmitMidiBatch([bytes]).catch(error => log(`MIDI send failed: ${error.message}`));
    return true;
}

function sendCC(cc, value, channel = 1) {
    const status = 0xB0 | (channel - 1);
    if (sendMidi([status, cc, Math.min(MIDI.MAX, Math.max(MIDI.MIN, value))])) {
        log(`CC ${cc} = ${value} (ch ${channel})`);
    }
}

function sendNote(note, velocity = 100, channel = 1) {
    const noteOn = 0x90 | (channel - 1);
    const noteOff = 0x80 | (channel - 1);
    // Send both immediately - TP-7 just needs the trigger
    if (sendMidi([noteOn, note, velocity])) {
        sendMidi([noteOff, note, 0]);
        log(`Cue ${note}`);
    }
}

function sendPitchBend(value, channel = 1) {
    const bent = value + MIDI.PITCH_OFFSET;
    const lsb = bent & 0x7F;
    const msb = (bent >> 7) & 0x7F;
    const status = 0xE0 | (channel - 1);
    if (sendMidi([status, lsb, msb])) {
        log(`Pitch Bend = ${value}`);
    }
}

function sendAllState() {
    log('Sending all state to device...');

    // Send mixer state (6 stereo tracks)
    document.querySelectorAll('.channel-strip').forEach((strip, i) => {
        const track = i + 1;
        const slider = strip.querySelector('.vol-slider');
        const muteBtn = strip.querySelector('.mute-btn');
        const muted = muteBtn.classList.contains('active');
        sendCC(TP7.CC_VOLUME, parseInt(slider.value), track);
        sendCC(TP7.CC_MUTE, muted ? MIDI.ON : MIDI.OFF, track);
    });

    // Send input gains
    document.querySelectorAll('.gain-slider').forEach((slider, i) => {
        sendCC(TP7.CC_GAIN, parseInt(slider.value), i + 1);
    });

    // Send pitch bend
    const pitchValue = parseInt(document.getElementById('pitch-bend').value);
    sendPitchBend(pitchValue);

    // Send transport/rocker state
    sendCC(TP7.CC_TRANSPORT, state.transport);

    // Loop state NOT sent on reconnect - In/Out are position markers,
    // we don't have the actual positions saved, only UI state.
    // Reset UI to match unknown device state.
    state.loopState = 'off';
    updateLoopState('off');

    // Send cue rec mode
    sendCC(TP7.CC_CUE_REC, state.cueRecMode ? MIDI.ON : MIDI.OFF);

    log('All state sent');
}

// =====================================================================
// Logging
// =====================================================================

function log(msg) {
    const logEl = document.getElementById('log');
    const time = new Date().toLocaleTimeString();
    const entry = document.createElement('div');
    entry.className = 'entry';
    entry.innerHTML = `<span class="time">${time}</span><span class="msg">${msg}</span>`;
    logEl.insertBefore(entry, logEl.firstChild);
    while (logEl.children.length > 50) {
        logEl.removeChild(logEl.lastChild);
    }
}

// =====================================================================
// Transport State
// =====================================================================

// Logarithmic slider: slider 0-100% maps to CC values
// Ticks adjusted for thumb offset
const ROCKER_MAP = [
    { pct: 0, cc: TP7.SPEED_MAX_REW },
    { pct: 28, cc: 48 },
    { pct: 40, cc: TP7.SPEED_REW_1X },
    { pct: 50, cc: TP7.SPEED_STOP },
    { pct: 60, cc: TP7.SPEED_FWD_1X },
    { pct: 69, cc: 80 },
    { pct: 100, cc: TP7.SPEED_MAX_FWD }
];

function sliderToCC(pct) {
    for (let i = 0; i < ROCKER_MAP.length - 1; i++) {
        if (pct <= ROCKER_MAP[i + 1].pct) {
            const t = (pct - ROCKER_MAP[i].pct) / (ROCKER_MAP[i + 1].pct - ROCKER_MAP[i].pct);
            return Math.round(ROCKER_MAP[i].cc + t * (ROCKER_MAP[i + 1].cc - ROCKER_MAP[i].cc));
        }
    }
    return MIDI.MAX;
}

function ccToSlider(cc) {
    for (let i = 0; i < ROCKER_MAP.length - 1; i++) {
        if (cc <= ROCKER_MAP[i + 1].cc) {
            const t = (cc - ROCKER_MAP[i].cc) / (ROCKER_MAP[i + 1].cc - ROCKER_MAP[i].cc);
            return ROCKER_MAP[i].pct + t * (ROCKER_MAP[i + 1].pct - ROCKER_MAP[i].pct);
        }
    }
    return 100;
}

function updateTransportState(value) {
    invalidateTempo();
    state.transport = value;

    document.getElementById('speed-slider').value = ccToSlider(value);
    document.getElementById('speed-value').textContent = `(MIDI value: ${value})`;

    document.querySelectorAll('.transport-btn[data-speed]').forEach(btn => {
        btn.classList.toggle('active', parseInt(btn.dataset.speed) === value);
    });

    // Update rocker preset buttons
    document.querySelectorAll('.rocker-preset').forEach(btn => {
        btn.classList.toggle('active', parseInt(btn.dataset.val) === value);
    });

    const stateEl = document.getElementById('transport-state');
    const rockerStateEl = document.getElementById('rocker-state');
    let stateName, stateClass, rockerSpeed;

    // Calculate rocker speed multiplier
    // Formula: speed = (value - SPEED_STOP) / 4
    // 64 = 0x (stop), 68 = +1x, 60 = -1x, 0 = -16x, 127 = +15.75x
    const speedMult = (value - TP7.SPEED_STOP) / 4;
    if (value === TP7.SPEED_STOP) {
        rockerSpeed = '0x';
    } else {
        rockerSpeed = speedMult > 0 ? `+${speedMult.toFixed(2)}x` : `${speedMult.toFixed(2)}x`;
    }

    if (value === TP7.SPEED_STOP) {
        stateName = '⏹ Stop';
        stateClass = 'stopped';
    } else if (value < TP7.SPEED_STOP) {
        stateName = '◀ Rew';
        stateClass = 'rewinding';
    } else {
        stateName = '▶ Fwd';
        stateClass = value === TP7.SPEED_FWD_1X ? 'playing' : 'forwarding';
    }

    stateEl.textContent = stateName;
    stateEl.className = 'transport-state ' + stateClass;
    if (rockerStateEl) rockerStateEl.textContent = rockerSpeed;
}

function updatePitchDisplay(pitch) {
    invalidateTempo();
    const multiplierStr = `x${TP7Tempo.multiplier(pitch).toFixed(8)}`;
    document.getElementById('speed-multiplier').textContent = multiplierStr;
    document.getElementById('pitch-value').textContent = `(pitch: ${pitch})`;
}

// =====================================================================
// BPM matching
// =====================================================================

function invalidateTempo() {
    tempoRevision++;
    tempoLastSent = null;
    updateTempoPreview();
}

function tempoInputs() {
    return [document.getElementById('tempo-source').value, document.getElementById('tempo-target').value];
}

function tempoNumber(value) {
    // Keep small nonzero errors visible instead of rounding them to zero.
    if (value !== 0 && Math.abs(value) < 0.00000001) return value.toExponential(6);
    return value.toFixed(8).replace(/\.?0+$/, '');
}

function updateTempoPreview() {
    const button = document.getElementById('tempo-apply');
    const result = document.getElementById('tempo-result');
    if (!button || !result) return;
    button.disabled = true;
    button.textContent = tempoPending ? 'Sending…' : 'Apply';
    result.dataset.status = '';
    const inputs = tempoInputs();
    if (inputs.some(value => !value.trim())) {
        result.textContent = 'Enter the track BPM and target BPM.';
        return;
    }
    try {
        const match = TP7Tempo.calculate(...inputs);
        const difference = match.exact ? '0 (exact in this mapping)' :
            `${match.errorBpm > 0 ? '+' : ''}${tempoNumber(match.errorBpm)}`;
        const sent = tempoLastSent === JSON.stringify(inputs);
        const prefix = sent ? 'Sent · predicted' : 'Preview';
        result.textContent = `${prefix}: ${tempoNumber(match.achievedBpm)} BPM · Δ ${difference} BPM · speed ×${tempoNumber(match.multiplier)} · pitch ${match.pitch}.`;
        if (!isMidiConnected()) result.textContent += ' Connect TP-7 to apply.';
        if (sent) result.dataset.status = 'sent';
        button.disabled = tempoPending || !isMidiConnected();
    } catch (error) {
        result.textContent = error.message;
        result.dataset.status = 'error';
    }
}

function setTransport(value) {
    const playbackMode = document.getElementById('playmode-comp').checked;
    sendCC(TP7.CC_TRANSPORT, value);

    if (playbackMode) {
        const pitchSlider = document.getElementById('pitch-bend');
        if (value === TP7.SPEED_STOP) {
            // "Play" button in playback mode: reset pitch to 0
            sendPitchBend(MIDI.MIN);
            pitchSlider.value = MIDI.MIN;
            document.getElementById('pitch-manual').value = MIDI.MIN;
            updatePitchDisplay(MIDI.MIN);
        } else {
            // Other buttons: add pitch compensation
            sendPitchBend(TP7.STOP_COMPENSATION_PITCH);
            pitchSlider.value = TP7.STOP_COMPENSATION_PITCH;
            document.getElementById('pitch-manual').value = TP7.STOP_COMPENSATION_PITCH;
            updatePitchDisplay(TP7.STOP_COMPENSATION_PITCH);
        }
    }
    updateTransportState(value);
    document.getElementById('rocker-manual').value = value;
}

// =====================================================================
// Loop State
// =====================================================================

function updateLoopState(newState) {
    state.loopState = newState;

    const offBtn = document.getElementById('loop-off');
    const inBtn = document.getElementById('loop-in');
    const outBtn = document.getElementById('loop-out');
    const statusEl = document.getElementById('loop-status');

    // Reset all buttons
    offBtn.className = 'toggle-btn';
    inBtn.className = 'toggle-btn';
    outBtn.className = 'toggle-btn';

    switch (newState) {
        case 'off':
            offBtn.classList.add('active');
            // In/Out unlocked, ready to set new loop
            statusEl.className = 'loop-status idle';
            statusEl.textContent = 'No loop set';
            break;
        case 'in':
            inBtn.classList.add('loop-in');
            // In is locked (already set), Out is available
            inBtn.classList.add('locked');
            statusEl.className = 'loop-status in-set';
            statusEl.textContent = '🔶 Loop IN set - click OUT to complete';
            break;
        case 'out':
            inBtn.classList.add('loop-in', 'locked');
            outBtn.classList.add('loop-out', 'locked');
            // Both locked - only Off can be clicked
            statusEl.className = 'loop-status active';
            statusEl.textContent = '🔁 Loop active - click OFF to clear';
            break;
    }
}

function handleLoopClick(mode) {
    if (mode === 0) {
        // Off - always allowed
        sendCC(TP7.CC_LOOP, 0);
        updateLoopState('off');
    } else if (mode === 1) {
        // In - only allowed when off
        if (state.loopState === 'off') {
            sendCC(TP7.CC_LOOP, 1);
            updateLoopState('in');
        } else {
            log('Cannot change IN - clear loop first with OFF');
        }
    } else if (mode === 2) {
        // Out - only allowed when in is set
        if (state.loopState === 'in') {
            sendCC(TP7.CC_LOOP, 2);
            updateLoopState('out');
        } else if (state.loopState === 'out') {
            log('Loop already active - click OFF to clear');
        } else {
            log('Set Loop IN first');
        }
    }
}

// =====================================================================
// Channel Strips (Mixer)
// =====================================================================

function createChannelStrips() {
    const container = document.getElementById('channel-strips');
    container.innerHTML = '';

    // Stereo tracks controlled via MIDI channels 1-6
    for (let track = 1; track <= TP7.STEREO_TRACKS; track++) {
        const strip = document.createElement('div');
        strip.className = 'channel-strip';
        strip.dataset.channel = track;
        strip.innerHTML = `
            <div class="ch-label">Track ${track}</div>
            <div class="ch-value">100%</div>
            <div class="fader-container">
                <div class="fader-scale">
                    <span>— 100</span>
                    <span>— 75</span>
                    <span>— 50</span>
                    <span>— 25</span>
                    <span>— 0</span>
                </div>
                <div class="fader-track">
                    <input type="range" class="vol-slider" min="0" max="127" value="127">
                </div>
            </div>
            <button class="mute-btn">🔇 Mute</button>
        `;
        container.appendChild(strip);

        const slider = strip.querySelector('.vol-slider');
        const valueDisplay = strip.querySelector('.ch-value');
        const muteBtn = strip.querySelector('.mute-btn');

        slider.addEventListener('input', () => {
            const pct = Math.round((slider.value / MIDI.MAX) * 100);
            valueDisplay.textContent = pct + '%';
            sendCC(TP7.CC_VOLUME, parseInt(slider.value), track);
        });

        muteBtn.addEventListener('click', () => {
            muteBtn.classList.toggle('active');
            const muted = muteBtn.classList.contains('active');
            muteBtn.textContent = muted ? '🔊 Unmute' : '🔇 Mute';
            sendCC(TP7.CC_MUTE, muted ? MIDI.ON : MIDI.OFF, track);
            // Also send fader value to sync volume
            sendCC(TP7.CC_VOLUME, parseInt(slider.value), track);
        });
    }
}

// =====================================================================
// Input Gain Controls
// =====================================================================

function createGainControls() {
    const container = document.getElementById('gain-controls');
    container.innerHTML = '';

    // Convert MIDI value (0-127) to dB (0-42)
    function midiToDb(val) {
        return Math.round((val / MIDI.MAX) * TP7.MAX_GAIN_DB);
    }

    for (let input = 1; input <= TP7.INPUT_CHANNELS; input++) {
        const group = document.createElement('div');
        group.className = 'control-group';
        group.innerHTML = `
            <div class="gain-control">
                <div class="gain-header">
                    <label>Input ${input}</label>
                    <span class="gain-value">0dB</span>
                </div>
                <div class="gain-slider-container">
                    <div class="gain-scale">
                        <span>0dB</span>
                        <span>21dB</span>
                        <span>42dB</span>
                    </div>
                    <input type="range" class="gain-slider" data-input="${input}" min="0" max="127" value="0">
                </div>
                <div class="gain-buttons">
                    <button class="gain-min" data-input="${input}">0dB</button>
                    <button class="gain-mid" data-input="${input}">21dB</button>
                    <button class="gain-max" data-input="${input}">42dB</button>
                </div>
            </div>
        `;
        container.appendChild(group);

        const slider = group.querySelector('.gain-slider');
        const valueDisplay = group.querySelector('.gain-value');

        slider.addEventListener('input', () => {
            const db = midiToDb(slider.value);
            valueDisplay.textContent = db + 'dB';
            sendCC(TP7.CC_GAIN, parseInt(slider.value), input);
        });

        group.querySelector('.gain-min').addEventListener('click', () => {
            slider.value = MIDI.MIN;
            valueDisplay.textContent = '0dB';
            sendCC(TP7.CC_GAIN, MIDI.MIN, input);
        });

        group.querySelector('.gain-mid').addEventListener('click', () => {
            slider.value = MIDI.CENTER;
            valueDisplay.textContent = `${Math.round(TP7.MAX_GAIN_DB / 2)}dB`;
            sendCC(TP7.CC_GAIN, MIDI.CENTER, input);
        });

        group.querySelector('.gain-max').addEventListener('click', () => {
            slider.value = MIDI.MAX;
            valueDisplay.textContent = `${TP7.MAX_GAIN_DB}dB`;
            sendCC(TP7.CC_GAIN, MIDI.MAX, input);
        });
    }
}

// =====================================================================
// Cue Markers
// =====================================================================

function createCueButtons() {
    const grid = document.getElementById('cue-grid');
    grid.innerHTML = '';

    for (let i = 0; i < state.cueCount; i++) {
        const btn = document.createElement('button');
        btn.className = 'cue-btn';
        btn.dataset.note = i;
        btn.innerHTML = `${i}<span class="cue-indicator"></span>`;

        if (state.cues.has(i)) {
            btn.classList.add('set');
        }

        btn.addEventListener('click', () => handleCueClick(i, btn));
        grid.appendChild(btn);
    }
}

function handleCueClick(note, btn) {
    sendNote(note, 100, 1);

    // Flash animation
    btn.classList.remove('triggered');
    void btn.offsetWidth; // Force reflow to restart animation
    btn.classList.add('triggered');
    setTimeout(() => btn.classList.remove('triggered'), 300);

    if (state.cueRecMode) {
        // Recording a cue marker
        state.cues.add(note);
        btn.classList.add('set');
    }
}

function clearAllCues() {
    state.cues = new Set();
    // Remove set class from all existing buttons in the grid
    const grid = document.getElementById('cue-grid');
    if (grid) {
        grid.querySelectorAll('.cue-btn').forEach(btn => {
            btn.classList.remove('set');
        });
    }
    log('UI cleared. To clear actual cues on TP-7: change track!');
    // Save to localStorage
    if (typeof saveControlState === 'function') {
        saveControlState();
    }
}

// =====================================================================
// Connection Management
// =====================================================================

async function initMIDI() {
    try {
        midiAccess = await navigator.requestMIDIAccess({ sysex: false });
        refreshOutputs();
        midiAccess.onstatechange = (e) => {
            refreshOutputs();
            // Check if our connected device was disconnected
            if (midiOutput && e.port.id === midiOutput.id && e.port.state === 'disconnected') {
                midiOutput = null;
                if (connectionType === 'usb') connectionType = null;
                updateStatus('disconnected', 'TP-7 disconnected');
                log('TP-7 disconnected');
            }
            autoConnectTP7();
        };
        log('MIDI access granted');
        // Try auto-connect on init
        autoConnectTP7();
    } catch (err) {
        log('MIDI access denied: ' + err.message);
        updateStatus('disconnected', 'MIDI Access Denied');
    }
}

function autoConnectTP7() {
    if (midiOutput || connectionType === 'ble') return; // Already connected

    for (const output of midiAccess.outputs.values()) {
        if (output.name.toLowerCase().includes('tp-7')) {
            midiOutput = output;
            connectionType = 'usb';
            // Update dropdown selection
            document.getElementById('midi-output').value = output.id;
            updateStatus('connected', `USB: ${output.name}`);
            log(`Auto-connected to ${output.name}`);
            sendAllState();
            return;
        }
    }
}

function refreshOutputs() {
    const outSelect = document.getElementById('midi-output');
    outSelect.innerHTML = '<option value="">Select MIDI Output...</option>';

    if (!midiAccess) return;

    for (const output of midiAccess.outputs.values()) {
        const option = document.createElement('option');
        option.value = output.id;
        option.textContent = output.name;
        if (output.name.toLowerCase().includes('tp-7')) {
            option.selected = true;
        }
        outSelect.appendChild(option);
    }
}

function connect() {
    const outSelect = document.getElementById('midi-output');
    const outputId = outSelect.value;

    if (!outputId) {
        log('Please select a MIDI output');
        return;
    }

    midiOutput = midiAccess.outputs.get(outputId);

    if (midiOutput) {
        connectionType = 'usb';
        updateStatus('connected', `USB: ${midiOutput.name}`);
        log(`Connected to ${midiOutput.name}`);
        sendAllState();
    } else {
        updateStatus('disconnected', 'Connection failed');
        log('Failed to connect');
    }
}

function updateStatus(statusState, text) {
    invalidateTempo();
    window.tp7RemotePanel?.connectionChanged();
    const statusEl = document.getElementById('status');
    const statusText = document.getElementById('status-text');
    const connectBtn = document.getElementById('connect-btn');
    statusEl.className = statusState;
    statusText.textContent = text;

    // Disable connect button when connected
    if (statusState === 'connected') {
        connectBtn.disabled = true;
        connectBtn.textContent = 'Connected';
    } else {
        connectBtn.disabled = false;
        connectBtn.textContent = 'Connect';
    }
}

// =====================================================================
// BLE MIDI Connection
// =====================================================================

async function connectBLE() {
    if (!navigator.bluetooth) {
        log('Web Bluetooth not supported');
        return;
    }

    try {
        updateBLEStatus('connecting', 'Scanning...');
        log('Scanning for BLE MIDI devices...');

        bleDevice = await navigator.bluetooth.requestDevice({
            filters: [
                { services: [BLE_MIDI_SERVICE] },
                { namePrefix: 'TP-7' }
            ],
            optionalServices: [BLE_MIDI_SERVICE, TP7CompanionBLE.SERVICE]
        });

        bleDevice.addEventListener('gattserverdisconnected', onBLEDisconnected);

        updateBLEStatus('connecting', 'Connecting...');
        const server = await bleDevice.gatt.connect();

        const service = await server.getPrimaryService(BLE_MIDI_SERVICE);
        bleMidiCharacteristic = await service.getCharacteristic(BLE_MIDI_CHARACTERISTIC);

        connectionType = 'ble';
        updateBLEStatus('connected', `BLE: ${bleDevice.name}`);
        log(`Connected to ${bleDevice.name} via Bluetooth`);
        sendAllState();

        document.getElementById('ble-connect-btn').style.display = 'none';
        document.getElementById('ble-disconnect-btn').style.display = 'inline-block';

    } catch (err) {
        console.error('BLE connection error:', err);
        updateBLEStatus('disconnected', 'Connection failed');
        log(`BLE Error: ${err.message}`);
    }
}

function disconnectBLE() {
    if (bleDevice && bleDevice.gatt.connected) {
        bleDevice.gatt.disconnect();
    }
    onBLEDisconnected();
}

function onBLEDisconnected() {
    bleMidiCharacteristic = null;
    if (connectionType === 'ble') {
        connectionType = null;
    }
    updateBLEStatus('disconnected', 'Disconnected');
    log('BLE disconnected');

    document.getElementById('ble-connect-btn').style.display = 'inline-block';
    document.getElementById('ble-disconnect-btn').style.display = 'none';
}

function updateBLEStatus(statusState, text) {
    invalidateTempo();
    window.tp7RemotePanel?.connectionChanged();
    const statusEl = document.getElementById('ble-status');
    const statusText = document.getElementById('ble-status-text');
    statusEl.className = statusState;
    statusText.textContent = text;
}

// =====================================================================
// UI Event Handlers
// =====================================================================

document.addEventListener('DOMContentLoaded', () => {
    initMIDI();
    createChannelStrips();
    createGainControls();
    createCueButtons();

    let tempoTrack = null, tempoSourceKind = 'none', cueReadPending = false;
    const sourceInput = document.getElementById('tempo-source');
    const sourceInfo = document.getElementById('tempo-source-info');
    const cueReadButton = document.getElementById('tempo-read-cue');
    function updateCueReadButton(remote = window.tp7RemotePanel?.getState()) {
        cueReadButton.disabled = cueReadPending || !!remote?.busy;
        cueReadButton.textContent = cueReadPending ? 'Reading cue…' : 'Read from cue';
    }
    const currentTrack = remote => remote.enabled && remote.file ? `${remote.connection}:${TP7DJCues.trackKey(remote.file)}` : null;
    document.addEventListener('tp7-remote-state', event => {
        updateCueReadButton(event.detail);
        const next = currentTrack(event.detail);
        if (next === tempoTrack) return;
        tempoTrack = next; tempoFileRevision++; tempoSourceKind = 'none';
        sourceInput.value = '';
        sourceInfo.textContent = next ? `${event.detail.file.filename} · waiting for cue BPM, or enter manually.` : 'Enter BPM, or load it from the matching cue file.';
        invalidateTempo();
    });
    window.tp7TempoSource = {
        capture: () => tempoFileRevision,
        fromCue(source, revision) {
            const remote = window.tp7RemotePanel.getState();
            if (revision !== tempoFileRevision || !tempoTrack || currentTrack(remote) !== tempoTrack ||
                source.filename !== remote.file.filename || source.sampleRate !== remote.file.sampleRate || source.numFrames !== remote.file.numFrames ||
                (tempoSourceKind === 'manual' && sourceInput.value.trim())) return;
            tempoFileRevision++; tempoSourceKind = 'cue';
            sourceInput.value = source.bpm === null ? '' : source.bpm.toLocaleString('en-US', { useGrouping: false, maximumSignificantDigits: 21 });
            sourceInfo.textContent = source.bpm === null ? `${source.filename} · no BPM in cue file. Enter it manually.` : `${source.filename} · BPM from cue file`;
            invalidateTempo();
        },
    };
    for (const id of ['tempo-source', 'tempo-target']) {
        document.getElementById(id).addEventListener('input', () => {
            if (id === 'tempo-source') {
                // A slow file read must not overwrite a newer manual edit.
                tempoFileRevision++;
                tempoSourceKind = 'manual';
                sourceInfo.textContent = 'Manual BPM for the current track.';
            }
            invalidateTempo();
        });
    }

    cueReadButton.addEventListener('click', async () => {
        if (connectionType !== 'ble' || !isMidiConnected()) {
            sourceInfo.textContent = 'Connect TP-7 via Bluetooth to read its matching cue file.';
            return;
        }
        if (cueReadPending || window.tp7RemotePanel.getState().busy) return;
        cueReadPending = true; updateCueReadButton();
        // An explicit read replaces the previous value; subsequent manual edits
        // still win through the existing revision check in fromCue().
        tempoFileRevision++; tempoSourceKind = 'cue'; sourceInput.value = '';
        sourceInfo.textContent = 'Reading BPM from the current track’s cue file…';
        invalidateTempo();
        try {
            if (!await window.tp7RemotePanel.enableCueMode()) throw new Error(document.getElementById('remote-status').textContent);
            const ok = await window.tp7CuePanel.read();
            if (!ok && window.tp7RemotePanel.getState().enabled && tempoSourceKind !== 'manual') {
                sourceInfo.textContent = document.getElementById('carrier-status').textContent;
            }
        } catch (error) {
            if (window.tp7RemotePanel.getState().enabled && tempoSourceKind !== 'manual') sourceInfo.textContent = error.message;
        } finally { cueReadPending = false; updateCueReadButton(); }
    });

    document.getElementById('tempo-form').addEventListener('submit', async event => {
        event.preventDefault();
        if (tempoPending) return;
        const revision = tempoRevision;
        const inputs = tempoInputs();
        let failure = null;
        try {
            const match = TP7Tempo.calculate(...inputs);
            if (!isMidiConnected()) throw new Error('Connect TP-7 before applying tempo.');
            tempoPending = true;
            tempoLastSent = null;
            updateTempoPreview();
            // CC18=64 releases the rocker during native playback. Do not use
            // setTransport(): its stop compensation would overwrite our pitch.
            await transmitMidiBatch([
                [0xB0, TP7.CC_TRANSPORT, TP7.SPEED_STOP],
                TP7Tempo.pitchBytes(match.pitch),
            ], () => revision === tempoRevision);
            if (revision !== tempoRevision) return;
            document.getElementById('pitch-bend').value = match.pitch;
            document.getElementById('pitch-manual').value = match.pitch;
            updatePitchDisplay(match.pitch);
            document.querySelectorAll('.pitch-preset').forEach(button => {
                button.classList.toggle('active', Number(button.dataset.pitch) === match.pitch);
            });
            document.getElementById('playmode-comp').checked = true;
            updatePlaybackModeUI(true);
            updateTransportState(TP7.SPEED_STOP);
            document.getElementById('rocker-manual').value = TP7.SPEED_STOP;
            tempoLastSent = JSON.stringify(inputs);
            saveControlState();
            log(`Tempo speed sent: pitch ${match.pitch}; predicted ${tempoNumber(match.achievedBpm)} BPM`);
        } catch (error) {
            if (revision === tempoRevision) failure = error.message;
        } finally {
            tempoPending = false;
            updateTempoPreview();
            if (failure) {
                const result = document.getElementById('tempo-result');
                result.textContent = `Tempo was not confirmed sent. ${failure}`;
                result.dataset.status = 'error';
            }
        }
    });

    // Send All mixer values
    document.getElementById('mixer-send-all').addEventListener('click', () => {
        document.querySelectorAll('.channel-strip').forEach((strip, i) => {
            const ch = i + 1;
            const slider = strip.querySelector('.vol-slider');
            const muteBtn = strip.querySelector('.mute-btn');
            const muted = muteBtn.classList.contains('active');
            sendCC(TP7.CC_VOLUME, parseInt(slider.value), ch);
            sendCC(TP7.CC_MUTE, muted ? MIDI.ON : MIDI.OFF, ch);
        });
        log('Sent all mixer values');
    });

    // Reset mixer
    document.getElementById('mixer-reset').addEventListener('click', () => {
        document.querySelectorAll('.channel-strip').forEach((strip, i) => {
            const ch = i + 1;
            const slider = strip.querySelector('.vol-slider');
            const valueDisplay = strip.querySelector('.ch-value');
            const muteBtn = strip.querySelector('.mute-btn');
            slider.value = MIDI.MAX;
            valueDisplay.textContent = '100%';
            muteBtn.classList.remove('active');
            muteBtn.textContent = '🔇 Mute';
            sendCC(TP7.CC_VOLUME, MIDI.MAX, ch);
            sendCC(TP7.CC_MUTE, MIDI.OFF, ch);
        });
        log('Mixer reset to defaults');
    });

    // Connection tabs
    document.querySelectorAll('.conn-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.conn-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            const tabName = tab.dataset.tab;
            document.getElementById('usb-connection').style.display = tabName === 'usb' ? 'flex' : 'none';
            document.getElementById('ble-connection').style.display = tabName === 'ble' ? 'flex' : 'none';
        });
    });

    // USB Connection buttons
    document.getElementById('connect-btn').addEventListener('click', connect);
    document.getElementById('refresh-btn').addEventListener('click', refreshOutputs);

    // BLE Connection buttons
    document.getElementById('ble-connect-btn').addEventListener('click', connectBLE);
    document.getElementById('ble-disconnect-btn').addEventListener('click', disconnectBLE);

    // Playback mode checkbox - remaps button labels/icons and adds compensation
    document.getElementById('playmode-comp').addEventListener('change', (e) => {
        updatePlaybackModeUI(e.target.checked);

        // Set pitch based on mode AND current transport state
        if (e.target.checked) {
            // If current transport is "Play" (64), pitch stays 0, else +708
            if (state.transport === TP7.SPEED_STOP) {
                document.getElementById('pitch-bend').value = MIDI.MIN;
                document.getElementById('pitch-manual').value = MIDI.MIN;
                updatePitchDisplay(MIDI.MIN);
                sendPitchBend(MIDI.MIN);
            } else {
                document.getElementById('pitch-bend').value = TP7.STOP_COMPENSATION_PITCH;
                document.getElementById('pitch-manual').value = TP7.STOP_COMPENSATION_PITCH;
                updatePitchDisplay(TP7.STOP_COMPENSATION_PITCH);
                sendPitchBend(TP7.STOP_COMPENSATION_PITCH);
            }
        } else {
            document.getElementById('pitch-bend').value = MIDI.MIN;
            document.getElementById('pitch-manual').value = MIDI.MIN;
            updatePitchDisplay(MIDI.MIN);
            sendPitchBend(MIDI.MIN);
        }
    });

    function updatePlaybackModeUI(playbackMode) {
        // Update button labels and icons
        document.querySelector('#btn-rew .label').textContent = playbackMode ? 'Stop' : 'Rew';
        document.querySelector('#btn-rew .icon').textContent = playbackMode ? '⏹️' : '◀️';
        document.querySelector('#btn-stop .label').textContent = playbackMode ? 'Play' : 'Stop';
        document.querySelector('#btn-stop .icon').textContent = playbackMode ? '▶️' : '⏹️';
        document.querySelector('#btn-play .label').textContent = playbackMode ? 'x2' : 'Play';
        document.querySelector('#btn-play .icon').textContent = playbackMode ? '⏩' : '▶️';
    }

    // Transport buttons
    document.querySelectorAll('.transport-btn[data-speed]').forEach(btn => {
        btn.addEventListener('click', () => {
            setTransport(parseInt(btn.dataset.speed));
        });
    });

    // Speed slider (logarithmic 0-100% -> CC 0-127)
    const speedSlider = document.getElementById('speed-slider');
    speedSlider.addEventListener('input', () => {
        setTransport(sliderToCC(parseFloat(speedSlider.value)));
    });

    // Speed slider markers (old class, keeping for compatibility)
    document.querySelectorAll('.slider-markers span').forEach(marker => {
        marker.addEventListener('click', () => {
            setTransport(parseInt(marker.dataset.val));
        });
    });

    // Rocker scale labels (new clickable scale with ticks)
    document.querySelectorAll('#section-rocker .scale-with-ticks span[data-val]').forEach(marker => {
        marker.addEventListener('click', () => {
            setTransport(parseInt(marker.dataset.val));
        });
    });

    // Pitch bend / Speed modifier
    const pitchSlider = document.getElementById('pitch-bend');

    function setPitch(pitch) {
        pitch = Math.max(MIDI.PITCH_MIN, Math.min(MIDI.PITCH_MAX, pitch));
        pitchSlider.value = pitch;
        document.getElementById('pitch-manual').value = pitch;
        updatePitchDisplay(pitch);
        sendPitchBend(pitch);
        // Update button active states
        document.querySelectorAll('.pitch-preset').forEach(btn => {
            const btnPitch = parseInt(btn.dataset.pitch);
            btn.classList.toggle('active', btnPitch === pitch);
        });
        // Note: playback mode stays on even if pitch is changed manually
    }

    pitchSlider.addEventListener('input', () => {
        setPitch(parseInt(pitchSlider.value));
    });

    // Pitch preset buttons
    document.querySelectorAll('.pitch-preset').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.pitch-preset').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            setPitch(parseInt(btn.dataset.pitch));
        });
    });

    // Rocker preset buttons
    document.querySelectorAll('.rocker-preset').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.rocker-preset').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            setTransport(parseInt(btn.dataset.val));
        });
    });

    // Set default active buttons
    document.querySelector('.pitch-preset[data-pitch="0"]')?.classList.add('active');
    document.querySelector('.rocker-preset[data-val="64"]')?.classList.add('active');

    // Manual pitch input
    document.getElementById('pitch-manual-apply').addEventListener('click', () => {
        const val = parseInt(document.getElementById('pitch-manual').value);
        if (!isNaN(val) && val >= MIDI.PITCH_MIN && val <= MIDI.PITCH_MAX) {
            setPitch(val);
        }
    });

    document.getElementById('pitch-manual').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            document.getElementById('pitch-manual-apply').click();
        }
    });

    // Manual rocker input
    document.getElementById('rocker-manual-apply').addEventListener('click', () => {
        const val = parseInt(document.getElementById('rocker-manual').value);
        if (!isNaN(val) && val >= MIDI.MIN && val <= MIDI.MAX) {
            setTransport(val);
        }
    });

    document.getElementById('rocker-manual').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            document.getElementById('rocker-manual-apply').click();
        }
    });

    // Pitch scale markers
    document.querySelectorAll('.pitch-scale span').forEach(marker => {
        marker.addEventListener('click', () => {
            setPitch(parseInt(marker.dataset.pitch));
        });
    });

    // Initialize display
    updatePitchDisplay(0);

    // Loop mode buttons
    document.getElementById('loop-off').addEventListener('click', () => handleLoopClick(0));
    document.getElementById('loop-in').addEventListener('click', () => handleLoopClick(1));
    document.getElementById('loop-out').addEventListener('click', () => handleLoopClick(2));

    // Cue rec mode
    const cueRecOff = document.getElementById('cue-rec-off');
    const cueRecOn = document.getElementById('cue-rec-on');

    cueRecOff.addEventListener('click', () => {
        state.cueRecMode = false;
        cueRecOff.classList.add('active');
        cueRecOn.classList.remove('active', 'rec-active');
        sendCC(TP7.CC_CUE_REC, MIDI.OFF);
    });

    cueRecOn.addEventListener('click', () => {
        state.cueRecMode = true;
        cueRecOn.classList.add('active', 'rec-active');
        cueRecOff.classList.remove('active');
        sendCC(TP7.CC_CUE_REC, MIDI.ON);
    });

    // Clear cues
    document.getElementById('cue-clear-all').addEventListener('click', () => {
        clearAllCues();
    });

    // Cue count control
    document.getElementById('cue-count-apply').addEventListener('click', () => {
        const input = document.getElementById('cue-count');
        let count = parseInt(input.value);
        // Round to nearest multiple of CUE_STEP
        count = Math.round(count / TP7.CUE_STEP) * TP7.CUE_STEP;
        count = Math.max(TP7.CUE_MIN, Math.min(TP7.CUE_MAX, count));
        input.value = count;
        state.cueCount = count;
        createCueButtons();
        log(`Cue count set to ${count}`);
    });

    // Initialize states
    updateTransportState(TP7.SPEED_STOP);
    updateLoopState('off');

    // Edit Layout Mode
    const editToggle = document.getElementById('edit-layout-toggle');
    let editMode = false;

    editToggle.addEventListener('click', () => {
        editMode = !editMode;
        editToggle.classList.toggle('active', editMode);
        editToggle.textContent = editMode ? 'Done Editing' : '✏️ Layout';
        toggleDraggable(editMode);
    });

    // Clear state button
    document.getElementById('clear-state-btn').addEventListener('click', () => {
        if (confirm('Clear all saved state (layout, mixer, gain settings)?')) {
            localStorage.removeItem('tp7-control-state');
            localStorage.removeItem('tp7-layout-order-v2');
            localStorage.removeItem('tp7-layout-order-v3');
            location.reload();
        }
    });

    function toggleDraggable(enabled) {
        const sections = document.querySelectorAll('#app > .section');
        sections.forEach((section, index) => {
            if (enabled) {
                section.classList.add('draggable');
                section.draggable = true;
                section.dataset.index = index;

                // Add reorder controls if not present
                if (!section.querySelector('.section-reorder')) {
                    const controls = document.createElement('div');
                    controls.className = 'section-reorder';
                    controls.innerHTML = `
                        <button class="move-btn move-up" title="Move up">▲</button>
                        <button class="move-btn move-down" title="Move down">▼</button>
                        <span class="drag-handle">⋮⋮</span>
                    `;
                    section.appendChild(controls);

                    controls.querySelector('.move-up').addEventListener('click', (e) => {
                        e.stopPropagation();
                        const prev = section.previousElementSibling;
                        if (prev && prev.classList.contains('section')) {
                            prev.before(section);
                            saveLayoutOrder();
                            updateMoveButtons();
                        }
                    });

                    controls.querySelector('.move-down').addEventListener('click', (e) => {
                        e.stopPropagation();
                        const next = section.nextElementSibling;
                        if (next && next.classList.contains('section')) {
                            next.after(section);
                            saveLayoutOrder();
                            updateMoveButtons();
                        }
                    });
                }
            } else {
                section.classList.remove('draggable', 'drag-over');
                section.draggable = false;
                // Remove reorder controls
                const controls = section.querySelector('.section-reorder');
                if (controls) controls.remove();
            }
        });
        if (enabled) updateMoveButtons();
    }

    function updateMoveButtons() {
        const sections = Array.from(document.querySelectorAll('#app > .section'));
        sections.forEach((section, i) => {
            const upBtn = section.querySelector('.move-up');
            const downBtn = section.querySelector('.move-down');
            if (upBtn) upBtn.disabled = i === 0;
            if (downBtn) downBtn.disabled = i === sections.length - 1;
        });
    }

    // Drag and Drop handlers
    let draggedEl = null;

    document.getElementById('app').addEventListener('dragstart', (e) => {
        if (!editMode || !e.target.classList.contains('section')) return;
        draggedEl = e.target;
        e.target.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
    });

    document.getElementById('app').addEventListener('dragend', (e) => {
        if (!editMode || !e.target.classList.contains('section')) return;
        e.target.classList.remove('dragging');
        document.querySelectorAll('.section.drag-over').forEach(el => el.classList.remove('drag-over'));
        draggedEl = null;
        saveLayoutOrder();
    });

    document.getElementById('app').addEventListener('dragover', (e) => {
        if (!editMode) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';

        const section = e.target.closest('.section');
        if (section && section !== draggedEl) {
            document.querySelectorAll('.section.drag-over').forEach(el => el.classList.remove('drag-over'));
            section.classList.add('drag-over');
        }
    });

    document.getElementById('app').addEventListener('drop', (e) => {
        if (!editMode) return;
        e.preventDefault();

        const dropTarget = e.target.closest('.section');
        if (dropTarget && draggedEl && dropTarget !== draggedEl) {
            const app = document.getElementById('app');
            const sections = Array.from(app.querySelectorAll('.section'));
            const draggedIdx = sections.indexOf(draggedEl);
            const dropIdx = sections.indexOf(dropTarget);

            if (draggedIdx < dropIdx) {
                dropTarget.after(draggedEl);
            } else {
                dropTarget.before(draggedEl);
            }
        }

        document.querySelectorAll('.section.drag-over').forEach(el => el.classList.remove('drag-over'));
    });

    function saveLayoutOrder() {
        const sections = document.querySelectorAll('#app > .section');
        const order = Array.from(sections).map(s => s.id);
        localStorage.setItem('tp7-layout-order-v3', JSON.stringify(order));
    }

    function loadLayoutOrder() {
        const saved = localStorage.getItem('tp7-layout-order-v3');
        const previous = saved ? null : localStorage.getItem('tp7-layout-order-v2');
        if (!saved && !previous) return;

        try {
            const order = JSON.parse(saved || previous);
            if (!Array.isArray(order)) return;
            const app = document.getElementById('app');

            order.forEach(id => {
                const section = document.getElementById(id);
                if (section) {
                    app.appendChild(section);
                }
            });
            if (!saved) {
                // Move only the mixer when upgrading an existing custom layout.
                document.getElementById('section-carrier').after(document.getElementById('section-mixer'));
                saveLayoutOrder();
            }
        } catch (e) {
            console.error('Failed to load layout order:', e);
        }
    }

    // Save control states to localStorage
    function saveControlState() {
        const controlState = {
            transport: state.transport,
            loopState: state.loopState,
            cueRecMode: state.cueRecMode,
            cues: Array.from(state.cues),
            cueCount: state.cueCount,
            pitchBend: parseInt(document.getElementById('pitch-bend').value),
            playmodeComp: document.getElementById('playmode-comp').checked,
            mixerVolumes: [],
            mixerMutes: [],
            inputGains: []
        };

        // Save mixer state
        document.querySelectorAll('.channel-strip').forEach((strip, i) => {
            const slider = strip.querySelector('.vol-slider');
            const muteBtn = strip.querySelector('.mute-btn');
            controlState.mixerVolumes[i] = parseInt(slider.value);
            controlState.mixerMutes[i] = muteBtn.classList.contains('active');
        });

        // Save input gain state
        document.querySelectorAll('.gain-slider').forEach((slider, i) => {
            controlState.inputGains[i] = parseInt(slider.value);
        });

        localStorage.setItem('tp7-control-state', JSON.stringify(controlState));
    }

    function loadControlState() {
        const saved = localStorage.getItem('tp7-control-state');
        if (!saved) return;

        try {
            const controlState = JSON.parse(saved);

            // Restore state object
            if (controlState.cueCount) {
                state.cueCount = controlState.cueCount;
                document.getElementById('cue-count').value = controlState.cueCount;
            }
            if (controlState.cues) {
                state.cues = new Set(controlState.cues);
            }

            // Restore pitch bend
            if (controlState.pitchBend !== undefined) {
                const pitch = Number(controlState.pitchBend);
                if (Number.isInteger(pitch) && pitch >= MIDI.PITCH_MIN && pitch <= MIDI.PITCH_MAX) {
                    document.getElementById('pitch-bend').value = pitch;
                    document.getElementById('pitch-manual').value = pitch;
                    updatePitchDisplay(pitch);
                    document.querySelectorAll('.pitch-preset').forEach(button => {
                        button.classList.toggle('active', Number(button.dataset.pitch) === pitch);
                    });
                }
            }

            // Restore transport
            if (controlState.transport !== undefined) {
                updateTransportState(controlState.transport);
            }

            // Restore loop state
            if (controlState.loopState) {
                updateLoopState(controlState.loopState);
            }

            // Restore cue rec mode
            if (controlState.cueRecMode) {
                state.cueRecMode = true;
                document.getElementById('cue-rec-on').classList.add('active', 'rec-active');
                document.getElementById('cue-rec-off').classList.remove('active');
            }

            // Restore playback mode
            if (controlState.playmodeComp !== undefined) {
                document.getElementById('playmode-comp').checked = controlState.playmodeComp;
                if (controlState.playmodeComp) {
                    updatePlaybackModeUI(true);
                }
            }

            // Restore mixer (elements created by createChannelStrips before this runs)
            if (controlState.mixerVolumes) {
                document.querySelectorAll('.channel-strip').forEach((strip, i) => {
                    if (controlState.mixerVolumes[i] !== undefined) {
                        const slider = strip.querySelector('.vol-slider');
                        const valueDisplay = strip.querySelector('.ch-value');
                        slider.value = controlState.mixerVolumes[i];
                        const pct = Math.round((slider.value / MIDI.MAX) * 100);
                        valueDisplay.textContent = pct + '%';
                    }
                    if (controlState.mixerMutes && controlState.mixerMutes[i]) {
                        const muteBtn = strip.querySelector('.mute-btn');
                        muteBtn.classList.add('active');
                        muteBtn.textContent = '🔊 Unmute';
                    }
                });
            }

            // Restore input gains (elements created by createGainControls before this runs)
            if (controlState.inputGains) {
                document.querySelectorAll('.gain-slider').forEach((slider, i) => {
                    if (controlState.inputGains[i] !== undefined) {
                        slider.value = controlState.inputGains[i];
                        const valueDisplay = slider.closest('.gain-control').querySelector('.gain-value');
                        const db = Math.round((slider.value / MIDI.MAX) * TP7.MAX_GAIN_DB);
                        valueDisplay.textContent = db + 'dB';
                    }
                });
            }

        } catch (e) {
            console.error('Failed to load control state:', e);
        }
    }

    // Auto-save on changes
    function setupAutoSave() {
        // Debounce save
        let saveTimeout;
        const debouncedSave = () => {
            clearTimeout(saveTimeout);
            saveTimeout = setTimeout(saveControlState, 500);
        };

        // Listen for changes
        document.getElementById('pitch-bend').addEventListener('input', debouncedSave);
        document.getElementById('speed-slider').addEventListener('input', debouncedSave);
        document.getElementById('channel-strips').addEventListener('input', debouncedSave);
        document.getElementById('channel-strips').addEventListener('click', debouncedSave);
        document.getElementById('gain-controls').addEventListener('input', debouncedSave);
        document.getElementById('loop-toggle').addEventListener('click', debouncedSave);
        document.getElementById('cue-grid').addEventListener('click', debouncedSave);
        document.getElementById('cue-count').addEventListener('change', debouncedSave);
        document.getElementById('playmode-comp').addEventListener('change', debouncedSave);
    }

    // Load saved layout and state on init
    loadLayoutOrder();
    loadControlState();
    setupAutoSave();

    // Hotkey popup
    document.getElementById('hotkey-btn').addEventListener('click', () => {
        document.getElementById('hotkey-popup').style.display = 'flex';
    });
    document.getElementById('hotkey-close').addEventListener('click', () => {
        document.getElementById('hotkey-popup').style.display = 'none';
    });
    document.getElementById('hotkey-popup').addEventListener('click', (e) => {
        if (e.target.id === 'hotkey-popup') {
            document.getElementById('hotkey-popup').style.display = 'none';
        }
    });

    // Keyboard bindings
    document.addEventListener('keydown', (e) => {
        // Ignore if typing in an input
        if (['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(e.target.tagName) || e.target.isContentEditable) return;

        // Close popup on Escape
        if (e.key === 'Escape') {
            document.getElementById('hotkey-popup').style.display = 'none';
            return;
        }

        // Number keys map directly: 1->1, 2->2, ..., 9->9, 0->0
        // Backtick ` also maps to 0 (convenient for Mac)
        if (e.key >= '1' && e.key <= '9') {
            triggerCueByKeyboard(parseInt(e.key));
            e.preventDefault();
        } else if (e.key === '0' || e.key === '`') {
            triggerCueByKeyboard(0);
            e.preventDefault();
        }
        // Transport shortcuts
        else if (e.key === ' ') { // Space = Play/Stop toggle
            if (state.transport === TP7.SPEED_STOP) {
                setTransport(TP7.SPEED_FWD_1X);
            } else {
                setTransport(TP7.SPEED_STOP);
            }
            e.preventDefault();
        }
        // Cue Rec toggle
        else if (e.key === 'c' || e.key === 'C') {
            state.cueRecMode = !state.cueRecMode;
            document.getElementById('cue-rec-on').classList.toggle('active', state.cueRecMode);
            document.getElementById('cue-rec-on').classList.toggle('rec-active', state.cueRecMode);
            document.getElementById('cue-rec-off').classList.toggle('active', !state.cueRecMode);
            sendCC(TP7.CC_CUE_REC, state.cueRecMode ? MIDI.ON : MIDI.OFF);
            e.preventDefault();
        }
        // Loop controls
        else if (e.key === 'i' || e.key === 'I') { // Loop In
            handleLoopClick(1);
            e.preventDefault();
        } else if (e.key === 'o' || e.key === 'O') { // Loop Out
            handleLoopClick(2);
            e.preventDefault();
        } else if (e.key === 'p' || e.key === 'P') { // Loop Off
            handleLoopClick(0);
            e.preventDefault();
        }
    });

    function triggerCueByKeyboard(cueNum) {
        if (cueNum >= state.cueCount) return;
        const btn = document.querySelector(`.cue-btn[data-note="${cueNum}"]`);
        if (btn) {
            handleCueClick(cueNum, btn);
        }
    }

    // =====================================================================
    // Dismissible Boxes
    // =====================================================================

    const DISMISSED_KEY = 'tp7-dismissed-boxes';

    function loadDismissedBoxes() {
        try {
            const dismissed = JSON.parse(localStorage.getItem(DISMISSED_KEY) || '[]');
            dismissed.forEach(id => {
                const box = document.getElementById(id);
                if (box) box.classList.add('dismissed');
            });
        } catch (e) {
            console.error('Failed to load dismissed boxes:', e);
        }
    }

    function saveDismissedBox(id) {
        try {
            const dismissed = JSON.parse(localStorage.getItem(DISMISSED_KEY) || '[]');
            if (!dismissed.includes(id)) {
                dismissed.push(id);
                localStorage.setItem(DISMISSED_KEY, JSON.stringify(dismissed));
            }
        } catch (e) {
            console.error('Failed to save dismissed box:', e);
        }
    }

    // Handle dismiss button clicks
    document.querySelectorAll('.dismiss-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const box = e.target.closest('.dismissible');
            if (box && box.id) {
                box.classList.add('dismissed');
                saveDismissedBox(box.id);
            }
        });
    });

    // Load dismissed state
    loadDismissedBoxes();
});
