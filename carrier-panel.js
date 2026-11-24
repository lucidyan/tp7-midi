document.addEventListener('DOMContentLoaded', () => {
    const el = id => document.getElementById(id), api = window.tp7RemotePanel, codec = TP7CueCarrier;
    let controller = null, decoded = null, identity = null, revision = 0, page = 0;
    let prepared = null, preparing = false, preparationRevision = 0;
    let autoTimer = null, attemptedKey = null, automaticRead = false, activeIndex = -1;
    const preferenceKey = 'tp7-carrier-preferences-v1';
    try {
        const saved = JSON.parse(localStorage.getItem(preferenceKey));
        if (typeof saved?.autoLoad === 'boolean') el('carrier-auto').checked = saved.autoLoad;
        if (typeof saved?.follow === 'boolean') el('carrier-follow').checked = saved.follow;
        if (['cue', 'legacy-wav'].includes(saved?.format)) el('carrier-format').value = saved.format;
    } catch { /* Optional storage, including private browsing. */ }
    function savePreferences() {
        try { localStorage.setItem(preferenceKey, JSON.stringify({ autoLoad: el('carrier-auto').checked,
            follow: el('carrier-follow').checked, format: el('carrier-format').value })); } catch { /* Optional storage. */ }
    }
    const selectionKey = () => `${identity}:${el('carrier-format').value}`;
    const clearAutoTimer = () => { clearTimeout(autoTimer); autoTimer = null; };
    const status = (text, error = false) => { el('carrier-status').textContent = text; el('carrier-status').dataset.status = error ? 'error' : ''; };
    function controls() {
        const remote = api.getState();
        const next = `${remote.connection}:${TP7DJCues.trackKey(remote.file)}`;
        if (next !== identity) {
            clearAutoTimer(); controller?.abort(); attemptedKey = null; activeIndex = -1;
            identity = next; revision++; decoded = null; page = 0; renderCues();
            status('Select the original track on TP-7.');
        }
        let helper = '';
        try { if (remote.file) helper = codec.helperName(remote.file.filename, el('carrier-format').value); } catch { /* Invalid names cannot be read. */ }
        el('carrier-track').textContent = remote.file ? `${remote.file.folder}/${remote.file.filename}` : 'Waiting for the current track…';
        el('carrier-target').textContent = helper ? `Expected helper: ${remote.file.folder}/${helper}` : '';
        el('carrier-read').disabled = !!controller || remote.busy || !remote.ready || !helper || connectionType !== 'ble';
        el('carrier-cancel').disabled = !controller || controller.signal.aborted;
        el('carrier-format').disabled = preparing || !!controller || remote.busy;
        el('carrier-prepare').disabled = preparing;
        el('carrier-download').disabled = !prepared || preparing;
        for (const button of el('carrier-cues').children) button.disabled = button.dataset.seekable === 'false' || !remote.ready || remote.busy || !!controller;
        updatePlayback(remote);
        scheduleAutoLoad(remote, helper);
    }
    function scheduleAutoLoad(remote, helper) {
        const key = selectionKey();
        if (!el('carrier-auto').checked || decoded || controller || preparing || remote.busy ||
            !remote.ready || !helper || connectionType !== 'ble' || document.hidden || attemptedKey === key) {
            clearAutoTimer(); return;
        }
        if (remote.playing !== false) {
            clearAutoTimer();
            status(remote.playing === true ? 'Auto-load queued for this track. Waiting for playback to stop.' :
                'Auto-load ready. Press Stop to load this track’s cue file.');
            return;
        }
        if (autoTimer !== null) return;
        // Coalesce file/transport notifications and recheck before any command.
        autoTimer = setTimeout(() => {
            autoTimer = null;
            const current = api.getState();
            if (key === selectionKey() && el('carrier-auto').checked && current.playing === false &&
                current.ready && !current.busy && !controller && !preparing && !document.hidden) loadCues(true);
        }, 250);
    }
    function updatePlayback(remote = api.getState(), followPage = true) {
        const hasPosition = decoded && !controller && remote.connected && remote.ready &&
            remote.positionMs !== null && remote.positionAgeMs !== null &&
            (remote.playing === false || remote.positionAgeMs <= 3000);
        const index = hasPosition ? codec.activeCueIndex(decoded, remote.positionMs) : -1;
        const changed = index !== activeIndex;
        if (followPage) activeIndex = index;
        if (followPage && changed && index >= 0 && el('carrier-follow').checked && page !== Math.floor(index / 32)) {
            page = Math.floor(index / 32); renderCues();
        }
        const next = hasPosition ? decoded.cues.findIndex(cue => cue.seekable !== false && cue.positionMs > remote.positionMs) : -1;
        for (const button of el('carrier-cues').children) {
            const number = Number(button.dataset.index), current = number === index;
            if (current) button.setAttribute('aria-current', 'step'); else button.removeAttribute('aria-current');
            button.classList.toggle('is-next', number === next);
            button.querySelector('.cue-state').textContent = current ? (remote.playing === true ? 'PLAYING' : 'CURRENT POSITION') : number === next ? 'NEXT' : '';
        }
        const live = el('carrier-live');
        live.dataset.playing = String(index >= 0 && remote.playing === true);
        // Announce section changes, not every position notification.
        const text = !decoded ? 'Load cues to follow playback.' : !decoded.cues.length ? 'This track has no cue markers.' :
            !hasPosition ? 'Waiting for a fresh TP-7 position…' : index < 0 ? 'No cue section at the reported position.' :
                `${remote.playing === true ? 'Playing' : remote.playing === false ? 'Stopped' : 'Position'} · Cue ${index + 1}${next >= 0 ? ` · Next: Cue ${next + 1}` : ' · Last section'}`;
        if (live.textContent !== text) live.textContent = text;
    }
    function renderCues() {
        el('carrier-cues').replaceChildren();
        const remote = api.getState();
        const cues = decoded?.cues || [], pages = Math.ceil(cues.length / 32);
        page = Math.max(0, Math.min(page, pages - 1));
        el('carrier-paging').hidden = pages <= 1;
        el('carrier-page').textContent = `${page + 1} / ${pages}`;
        el('carrier-prev').disabled = page === 0;
        el('carrier-next').disabled = page >= pages - 1;
        el('carrier-source').textContent = decoded ? `${decoded.kind === 'test' ? 'TEST points — not original WAV cues' : 'Track cues'} · ${cues.length} points${decoded.bpm ? ` · stored BPM ${decoded.bpm}` : ''}` : '';
        for (let index = page * 32; index < Math.min(cues.length, (page + 1) * 32); index++) {
            const cue = cues[index], button = document.createElement('button');
            button.type = 'button'; button.className = 'dj-cue'; button.dataset.position = cue.positionMs; button.dataset.index = index;
            button.dataset.seekable = String(cue.seekable);
            button.disabled = cue.seekable === false || !remote.ready || remote.busy || !!controller;
            const title = document.createElement('strong'); title.textContent = `${decoded.kind === 'test' ? 'Test' : 'Cue'} ${index + 1}`;
            const time = document.createElement('span'); time.textContent = TP7DJCues.formatTime(cue.positionMs);
            const sample = document.createElement('small'); sample.textContent = `Sample ${cue.sampleOffset}${cue.seekable === false ? ' · end marker (no jump)' : ''}`;
            const indicator = document.createElement('span'); indicator.className = 'cue-state';
            button.append(indicator, title, time, sample);
            button.addEventListener('click', async () => {
                if (cue.seekable === false) return;
                const selected = revision;
                const ok = await api.jumpTo(cue.positionMs, () => selected === revision);
                if (selected === revision) status(ok ? `Cue ${index + 1}: jump and playback acknowledged.` : el('remote-status').textContent, !ok);
            });
            el('carrier-cues').append(button);
        }
        updatePlayback(api.getState(), false);
    }
    async function loadCues(automatic = false) {
        const remote = api.getState();
        if (controller || remote.busy || !remote.ready || !remote.file || connectionType !== 'ble') return;
        clearAutoTimer(); attemptedKey = selectionKey(); automaticRead = automatic;
        const helperFormat = el('carrier-format').value;
        controller = new AbortController(); decoded = null; page = 0; renderCues(); controls();
        const selected = revision, tempoRevision = window.tp7TempoSource.capture();
        let result;
        const stages = { service: 'Opening companion Bluetooth…', identify: 'Identifying TP-7…', session: 'Stopping playback…',
            'enter-transfer': 'Opening the companion file…', audio: 'Receiving cue carrier…', decode: 'Checking signal, checksum and track identity…',
            cleanup: 'Closing transfer and restoring remote session…' };
        const ok = await api.runCompanionTask(async (device, file, check) => {
            result = await TP7CompanionBLE.readCarrier({ device, file, check, protocol: TP7RemoteProtocol, signal: controller.signal, helperFormat,
                update(summary) { if (stages[summary.stage]) status(stages[summary.stage]); } }, codec);
            return result.cleanupErrors.length === 0;
        });
        controller = null; automaticRead = false;
        if (selected !== revision) { controls(); return; }
        if (result?.result === 'cues-decoded' && !result.cleanupErrors.length) {
            decoded = result.carrier; renderCues();
            window.tp7TempoSource.fromCue(decoded, tempoRevision);
            status(`${decoded.cues.length} ${decoded.kind === 'test' ? 'test points' : 'prepared WAV cues'} received and validated.${ok ? ' Tap a point to jump and play.' : ' Start listening before using cues.'}`, !ok);
        } else {
            const message = result?.cleanupErrors.length ? result.cleanupErrors.join(' ') : result?.error || el('remote-status').textContent;
            const cleanup = result?.cleanupErrors.length ? ' Transfer cleanup was not confirmed; disconnect and reconnect before playback.' : '';
            if (automatic && result?.lastStage === 'enter-transfer' && !result.cleanupErrors.length) {
                status(`Cue file unavailable: ${codec.helperName(remote.file.filename, helperFormat)}. Copy it next to the WAV, then Reload cues.`);
            } else status(`${message}${cleanup}`, true);
        }
        controls();
        return decoded !== null;
    }
    window.tp7CuePanel = { read: () => loadCues() };
    el('carrier-read').addEventListener('click', () => loadCues());
    el('carrier-cancel').addEventListener('click', () => { controller?.abort(); controls(); });
    el('carrier-format').addEventListener('change', () => {
        clearAutoTimer(); controller?.abort(); attemptedKey = null; activeIndex = -1;
        revision++; decoded = null; prepared = null; savePreferences(); renderCues(); controls();
    });
    el('carrier-auto').addEventListener('change', () => {
        clearAutoTimer(); attemptedKey = null;
        if (!el('carrier-auto').checked && automaticRead) controller?.abort();
        savePreferences(); controls();
    });
    el('carrier-follow').addEventListener('change', () => {
        savePreferences(); activeIndex = -1; updatePlayback();
    });
    el('carrier-prev').addEventListener('click', () => { page--; renderCues(); controls(); });
    el('carrier-next').addEventListener('click', () => { page++; renderCues(); controls(); });

    function prepare(source) {
        prepared = codec.makeWave(source, el('carrier-format').value);
        el('carrier-preparation').textContent = `${prepared.filename} · ${prepared.cueCount} markers${source.bpm ? ` · ${source.bpm} BPM` : ''}. Save next to ${source.filename} on TP-7. Re-export after renaming.`;
    }
    el('carrier-prepare').addEventListener('click', () => el('carrier-file').click());
    el('carrier-file').addEventListener('change', async event => {
        const file = event.target.files[0]; event.target.value = '';
        if (!file) return;
        const selected = ++preparationRevision;
        prepared = null; preparing = true; controls();
        el('carrier-preparation').textContent = `Reading cue metadata from ${file.name} locally…`;
        try {
            let received = 0;
            const reader = { read: async (offset, length) => {
                received += length;
                if (received > 262144 || offset < 0 || offset + length > file.size) throw new Error('WAV metadata exceeded the preparation read limit.');
                return new Uint8Array(await file.slice(offset, offset + length).arrayBuffer());
            } };
            const metadata = await TP7WavCues.readWave(reader, file.size, null);
            if (selected === preparationRevision) prepare({ ...metadata, filename: file.name, kind: 'wav' });
        } catch (error) { if (selected === preparationRevision) el('carrier-preparation').textContent = error.message; }
        finally { if (selected === preparationRevision) { preparing = false; controls(); } }
    });
    el('carrier-download').addEventListener('click', () => {
        if (!prepared) return;
        const url = URL.createObjectURL(new Blob([prepared.bytes], { type: 'application/octet-stream' }));
        const link = document.createElement('a'); link.href = url; link.download = prepared.filename; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
    });
    document.addEventListener('tp7-remote-state', controls);
    document.addEventListener('visibilitychange', controls);
    let positionTimer = null;
    function startPositionTimer() {
        if (positionTimer === null) positionTimer = setInterval(() => { if (!document.hidden) updatePlayback(); }, 500);
    }
    window.addEventListener('pageshow', () => { startPositionTimer(); controls(); });
    window.addEventListener('pagehide', () => { clearAutoTimer(); clearInterval(positionTimer); positionTimer = null; controller?.abort(); });
    startPositionTimer();
    controls();
});
