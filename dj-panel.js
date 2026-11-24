document.addEventListener('DOMContentLoaded', () => {
    const cues = TP7DJCues;
    const el = id => document.getElementById(id);
    const storageKey = 'tp7-dj-grids-v1';
    const pageSize = 32;
    let preferences = new Map();
    try {
        const saved = JSON.parse(localStorage.getItem(storageKey));
        if (Array.isArray(saved)) preferences = new Map(saved.filter(entry => Array.isArray(entry) &&
            entry.length === 2 && typeof entry[0] === 'string' && entry[1] && typeof entry[1] === 'object').slice(-100));
    } catch { /* Storage is optional, including in private browsing. */ }
    let remote = {};
    let key;
    let grid = null;
    let pageIndex = 0;
    let revision = 0;
    let manualBpm = false;

    for (const [value, [, , label]] of Object.entries(cues.intervals)) {
        el('dj-interval').add(new Option(label, value));
    }
    for (let beats = 1; beats <= 12; beats++) el('dj-meter').add(new Option(String(beats), String(beats)));

    function save() {
        if (!key) return;
        preferences.delete(key);
        preferences.set(key, { bpm: el('dj-bpm').value.trim(), manualBpm,
            interval: el('dj-interval').value, beatsPerBar: Number(el('dj-meter').value) });
        while (preferences.size > 100) preferences.delete(preferences.keys().next().value);
        try { localStorage.setItem(storageKey, JSON.stringify([...preferences])); } catch { /* Keep working without persistence. */ }
    }

    function loadFile() {
        const file = remote.file;
        const saved = preferences.get(key);
        const inferred = cues.bpmFromFilename(file?.filename);
        manualBpm = saved?.manualBpm === true;
        el('dj-bpm').value = manualBpm && typeof saved?.bpm === 'string' ? saved.bpm.slice(0, 32) : inferred ?? '';
        el('dj-interval').value = saved && Object.hasOwn(cues.intervals, saved.interval) ? saved.interval : 'bar-4';
        el('dj-meter').value = String(Number.isInteger(saved?.beatsPerBar) && saved.beatsPerBar >= 1 && saved.beatsPerBar <= 12 ? saved.beatsPerBar : 4);
        el('dj-track').textContent = file ? file.filename : 'Enable cue mode and start listening';
        el('dj-bpm-source').textContent = manualBpm ? 'Saved manual BPM for this track.' :
            inferred ? `From filename: ${inferred} BPM. You can override it.` : 'Enter BPM, or use tempo_88 / bpm_128 / 128bpm in the filename.';
        for (const id of ['dj-bpm', 'dj-interval', 'dj-meter']) el(id).disabled = !file;
        regenerate();
    }

    function regenerate() {
        revision++;
        pageIndex = 0;
        grid = null;
        el('dj-action-status').textContent = '';
        el('dj-action-status').dataset.status = '';
        if (!remote.file) el('dj-summary').textContent = 'Waiting for the current file and its length.';
        else if (el('dj-enabled').checked && remote.enabled) {
            try {
                grid = cues.createGrid({ ...remote.file, bpm: el('dj-bpm').value,
                    interval: el('dj-interval').value, beatsPerBar: Number(el('dj-meter').value) });
                el('dj-summary').textContent = `${cues.formatTime(grid.durationMs)} · ${grid.bpm} BPM · ${grid.count} jumps · every ${grid.intervalLabel}`;
            } catch (error) { el('dj-summary').textContent = error.message; }
        }
        renderPage();
    }

    function renderPage() {
        const container = el('dj-grid');
        container.replaceChildren();
        const pages = grid ? Math.ceil(grid.count / pageSize) : 0;
        pageIndex = Math.max(0, Math.min(pageIndex, pages - 1));
        el('dj-paging').hidden = pages <= 1;
        el('dj-page').value = String(pageIndex + 1);
        el('dj-page').max = String(Math.max(1, pages));
        el('dj-page-total').textContent = `of ${pages}`;
        el('dj-prev').disabled = pageIndex === 0;
        el('dj-next').disabled = pageIndex >= pages - 1;
        if (grid && el('dj-enabled').checked && remote.enabled) {
            const fragment = document.createDocumentFragment();
            for (let index = pageIndex * pageSize; index < Math.min(grid.count, (pageIndex + 1) * pageSize); index++) {
                const point = grid.pointAt(index);
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'dj-cue';
                button.dataset.index = String(index);
                button.dataset.position = String(point.positionMs);
                button.setAttribute('aria-label', `Jump ${index + 1}, bar ${point.bar}, beat ${point.beat}, ${point.time}`);
                for (const [tag, text] of [['strong', String(index + 1).padStart(2, '0')],
                    ['span', `Bar ${point.bar} · beat ${point.beat}`], ['small', point.time]]) {
                    const child = document.createElement(tag);
                    child.textContent = text;
                    button.append(child);
                }
                button.addEventListener('click', () => jump(point));
                fragment.append(button);
            }
            container.append(fragment);
        }
        updateLive();
    }

    async function jump(point) {
        if (!el('dj-enabled').checked || !remote.enabled || !grid || remote.busy || !remote.ready) return;
        const selectedRevision = revision;
        el('dj-action-status').dataset.status = '';
        el('dj-action-status').textContent = `Jumping to ${point.time}…`;
        const success = await window.tp7RemotePanel.jumpTo(point.positionMs, () => selectedRevision === revision && el('dj-enabled').checked && remote.enabled);
        if (selectedRevision !== revision) return;
        el('dj-action-status').textContent = success ? `Jump ${point.index + 1} · ${point.time} · playback acknowledged.` :
            `Jump not completed. ${el('remote-status').textContent}`;
        el('dj-action-status').dataset.status = success ? 'sent' : 'error';
    }

    function updateLive() {
        el('dj-connection').textContent = !remote.connected ? 'Connect TP-7 to use the grid.' :
            !remote.ready ? 'Enable cue mode and start listening.' : remote.busy ? 'Waiting for TP-7…' :
                remote.positionMs === null ? 'Ready · tap a jump to play.' : `Device position ${cues.formatTime(remote.positionMs)} · tap a jump to play.`;
        // Highlight from actual device telemetry, never from an optimistic seek.
        let active = -1;
        if (grid && Number.isInteger(remote.positionMs)) {
            let low = 0;
            let high = grid.count;
            while (low < high) {
                const middle = Math.floor((low + high) / 2);
                if (grid.pointAt(middle).positionMs <= remote.positionMs) low = middle + 1;
                else high = middle;
            }
            active = low - 1;
        }
        for (const button of el('dj-grid').children) {
            button.disabled = !remote.ready || remote.busy;
            if (Number(button.dataset.index) === active) button.setAttribute('aria-current', 'step');
            else button.removeAttribute('aria-current');
        }
    }

    function receiveState(next) {
        remote = next;
        el('section-dj').hidden = !remote.enabled || !el('dj-enabled').checked;
        const nextKey = cues.trackKey(next.file);
        if (nextKey !== key) { key = nextKey; loadFile(); }
        else updateLive();
    }
    el('dj-bpm').addEventListener('input', () => {
        manualBpm = true;
        el('dj-bpm-source').textContent = 'Manual BPM · saved for this track in this browser.';
        save(); regenerate();
    });
    for (const id of ['dj-interval', 'dj-meter']) el(id).addEventListener('change', () => { save(); regenerate(); });
    el('dj-prev').addEventListener('click', () => { pageIndex--; renderPage(); });
    el('dj-next').addEventListener('click', () => { pageIndex++; renderPage(); });
    el('dj-page').addEventListener('change', () => {
        const requested = Number(el('dj-page').value);
        if (Number.isSafeInteger(requested)) pageIndex = requested - 1;
        renderPage();
    });
    el('dj-enabled').addEventListener('change', () => {
        el('section-dj').hidden = !remote.enabled || !el('dj-enabled').checked;
        regenerate();
    });
    document.addEventListener('tp7-remote-state', event => receiveState(event.detail));
    receiveState(window.tp7RemotePanel.getState());
});
