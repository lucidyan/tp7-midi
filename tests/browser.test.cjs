// Optional browser integration tests: requires Playwright and Chromium/Edge.
// No physical MIDI device is accessed; both transports are simulated.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');
const cueCarrier = require('../cue-carrier.js');
const carrierAudio = require('./helpers/carrier-audio.cjs');

let browser;
let server;
let url;
before(async () => {
    const root = path.join(__dirname, '..');
    const allowed = new Set(['/index.html', '/styles.css', '/tempo.js', '/app.js', '/remote-protocol.js', '/remote-panel.js', '/dj-cues.js', '/dj-panel.js', '/wav-cues.js', '/companion-ble.js', '/cue-carrier.js', '/carrier-panel.js']);
    server = http.createServer(async (request, response) => {
        const pathname = new URL(request.url, 'http://localhost').pathname;
        const name = pathname === '/' ? '/index.html' : pathname;
        if (!allowed.has(name)) { response.writeHead(404).end(); return; }
        try {
            const content = await fs.readFile(path.join(root, name));
            const type = name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html';
            response.writeHead(200, { 'Content-Type': type }).end(content);
        } catch { response.writeHead(500).end(); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({
        headless: true,
        ...(process.env.TP7_BROWSER_PATH ? { executablePath: process.env.TP7_BROWSER_PATH } : {}),
    });
});
after(async () => {
    await browser?.close();
    await new Promise(resolve => server ? server.close(resolve) : resolve());
});

async function openApp(t, mode = 'usb', autoLoad = false) {
    const context = await browser.newContext();
    t.after(() => context.close());
    await context.addInitScript(({ mode, autoLoad }) => {
        // Existing transport tests opt out of background reads; auto-load tests enable it explicitly.
        if (localStorage.getItem('tp7-carrier-preferences-v1') === null) {
            localStorage.setItem('tp7-carrier-preferences-v1', JSON.stringify({ autoLoad, follow: true, format: 'cue' }));
        }
        window.sent = [];
        window.bleSent = [];
        window.failSend = false;
        window.writeInProgress = false;
        window.releaseWrite = null;
        window.remoteMode = 'ok';
        window.remoteRequests = [];
        window.companionMode = 'ok';
        window.companionRequests = [];
        const notificationListeners = new Set();
        let requestDecoder = null;
        const output = {
            id: 'tp7', name: 'TP-7', state: 'connected',
            send(bytes) {
                if (window.failSend) throw new Error('Test USB failure');
                window.sent.push([...bytes]);
            },
        };
        const access = { inputs: new Map(), outputs: new Map(mode === 'usb' ? [['tp7', output]] : []) };
        window.testDisconnect = () => {
            output.state = 'disconnected';
            access.outputs.clear();
            access.onstatechange({ port: output });
        };
        Object.defineProperty(navigator, 'requestMIDIAccess', { value: async () => access });
        const characteristic = {
            addEventListener(name, fn) { if (name === 'characteristicvaluechanged') notificationListeners.add(fn); },
            removeEventListener(name, fn) { notificationListeners.delete(fn); },
            async startNotifications() {
                if (window.failNotifications) throw new Error('Notifications unavailable');
                return this;
            },
            async writeValueWithoutResponse(packet) {
                if (window.writeInProgress) throw new Error('Concurrent BLE writes');
                window.writeInProgress = true;
                try {
                    await new Promise(resolve => setTimeout(resolve, 1));
                    if (window.holdWrite) {
                        window.holdWrite = false;
                        await new Promise(resolve => { window.releaseWrite = resolve; });
                    }
                    if (window.failSend) throw new Error('Test BLE failure');
                    window.bleSent.push([...packet]);
                    if (!requestDecoder) {
                        requestDecoder = new TP7RemoteProtocol.BleReceiver(bytes => {
                            const fakeReply = [...bytes];
                            fakeReply[6] &= ~0x40;
                            fakeReply.splice(9, 0, 0);
                            const request = TP7RemoteProtocol.parse(fakeReply);
                            window.remoteRequests.push(request);
                            if (window.remoteMode === 'silent' || (window.remoteMode === 'silent-session' && request.command === 127 && request.data[0] === 64)) return;
                            let data = [];
                            let status = 0;
                            if (request.command === 1) data = [...new TextEncoder().encode('product:TP-7;sw_version:1.1.11;mode:normal;serial:test')];
                            if (request.command === 127) {
                                if (request.data[0] === 64) data = [66, 1];
                                if (request.data[0] === 80) data = [78, 1];
                                if (request.data[0] === 81) data = [78, 0];
                                if (request.data[0] === 76) {
                                    if (window.remoteMode === 'reject-seek') status = 3;
                                    else data = window.emptySeekAck ? [] : [77, ...request.data.slice(1)];
                                }
                            }
                            const reply = TP7RemoteProtocol.encode(request.id, request.command, data);
                            reply[6] &= ~0x40;
                            reply.splice(9, 0, status);
                            for (const fragment of TP7RemoteProtocol.blePackets(reply, 247)) {
                                characteristic.value = new DataView(fragment.buffer);
                                for (const fn of notificationListeners) fn({target:characteristic});
                            }
                            if (request.command === 127 && request.data[0] === 76 && status === 0 && window.emptySeekAck) {
                                window.emitCompanion([77, ...request.data.slice(1)]);
                            }
                            if (request.command === 127 && request.data[0] === 64) {
                                const sendTrack = () => {
                                    window.emitTrack(window.mockTrack?.filename || 'example_cues_15_tempo_88.wav', window.mockTrack?.numFrames || 4800000);
                                    window.emitCompanion([77, 227, 134, 0, 0]);
                                };
                                if (window.sessionTrackDelay) setTimeout(sendTrack, window.sessionTrackDelay); else sendTrack();
                            }
                            if (request.command === 127 && request.data[0] === 81 && window.changeFileOnStop) {
                                window.changeFileOnStop = false;
                                window.emitCompanion([75, 128, 187, 0, 0, 0, 62, 73, 0, 5, 26, 11, 16, 22, 35, 0,
                                    ...new TextEncoder().encode('recordings\0other.wav\0')]);
                            }
                        });
                    }
                    requestDecoder.push(packet);
                } finally { window.writeInProgress = false; }
            },
        };
        window.emitBle = bytes => {
            const padded = new Uint8Array(bytes.length + 6);
            padded.set(bytes, 3);
            characteristic.value = new DataView(padded.buffer, 3, bytes.length);
            for (const fn of notificationListeners) fn({target:characteristic});
        };
        window.emitCompanion = data => {
            const frame = TP7RemoteProtocol.encode(1, 127, data);
            frame[6] = 64; frame[7] = 0;
            for (const fragment of TP7RemoteProtocol.blePackets(frame, 247)) window.emitBle(fragment);
        };
        window.emitTrack = (filename, numFrames = 7832495) => {
            window.mockTrack = { filename, numFrames };
            const bytes = new Uint8Array(8);
            const view = new DataView(bytes.buffer);
            view.setUint32(0, 48000, true); view.setUint32(4, numFrames, true);
            window.emitCompanion([75, ...bytes, 5, 26, 11, 17, 12, 0, 0,
                ...new TextEncoder().encode(`recordings\0${filename}\0`)]);
        };
        const companionListeners = new Set();
        const companionEmit = bytes => {
            const padded = new Uint8Array(bytes.length + 4); padded.set(bytes, 2);
            companionCharacteristic.value = new DataView(padded.buffer, 2, bytes.length);
            for (const listener of companionListeners) listener({ target: companionCharacteristic });
        };
        const companionEvent = data => {
            const frame = TP7RemoteProtocol.encode(1, 127, data); frame[6] = 64; frame[7] = 0;
            for (const packet of TP7CompanionBLE.packets(frame)) companionEmit(packet);
        };
        let companionDecoder;
        const companionCharacteristic = {
            properties: { writeWithoutResponse: true },
            addEventListener: (_, fn) => companionListeners.add(fn), removeEventListener: (_, fn) => companionListeners.delete(fn),
            async startNotifications() {}, async stopNotifications() {},
            async writeValueWithoutResponse(packet) {
                companionDecoder ||= new TP7CompanionBLE.Receiver(frame => {
                    const reply = [...frame]; reply[6] &= ~64; reply.splice(9, 0, 0);
                    const request = TP7RemoteProtocol.parse(reply); window.companionRequests.push(request);
                    const data = request.command === 1 ? [...new TextEncoder().encode('product:TP-7;sw_version:1.1.11;')] : [];
                    if (request.data[0] === 67 && window.companionMode !== 'missing-file') companionEvent([69, 1]);
                    const response = TP7RemoteProtocol.encode(request.id, request.command, data); response[6] &= ~64; response.splice(9, 0, 0);
                    if (window.companionMode === 'missing-file' && request.data[0] === 67) response[9] = 2;
                    if (window.companionMode === 'cleanup-fail' && request.data[0] === 68) response[9] = 2;
                    for (const p of TP7CompanionBLE.packets(response)) companionEmit(p);
                    if (request.data[0] === 70 && window.companionMode !== 'silent') {
                        window.finishCarrier = () => {
                        if (window.carrierBlocks) {
                            for (const block of window.carrierBlocks) {
                                companionEmit(Uint8Array.from([2, 0, 0, 0, 0, ...block.slice(0, 239)]));
                                for (let at = 239; at < block.length; at += 243) companionEmit(Uint8Array.from([3, ...block.slice(at, at + 243)]));
                            }
                        } else {
                            companionEmit(Uint8Array.from([2, 0, 0, 0, 0, 1, 0, 0, 0]));
                            companionEmit(Uint8Array.from([3, ...new Uint8Array(16)]));
                        }
                        companionEvent([73, 0]);
                        };
                        if (!window.holdCarrier) window.finishCarrier();
                    }
                }, () => {});
                companionDecoder.push(packet);
            },
        };
        const device = {
            name: 'TP-7', addEventListener() {},
            gatt: { connected: true, async connect() { return this; }, async getPrimaryService(uuid) {
                if (uuid === TP7CompanionBLE.SERVICE && window.companionMode === 'missing') throw new Error('Companion service unavailable');
                return { async getCharacteristic() { return uuid === TP7CompanionBLE.SERVICE ? companionCharacteristic : characteristic; } };
            } },
        };
        Object.defineProperty(navigator, 'bluetooth', { value: { requestDevice: async options => { window.bluetoothOptions = options; return device; } } });
    }, { mode, autoLoad });
    const page = await context.newPage();
    page.setDefaultTimeout(8000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    t.after(() => assert.deepEqual(errors, []));
    await page.goto(url);
    if (mode === 'usb') await page.waitForFunction(() => window.sent.length >= 18);
    return page;
}

async function enterTempo(page, source = '120', target = '128') {
    await page.locator('#tempo-source').fill(source);
    await page.locator('#tempo-target').fill(target);
}

async function startRemote(page) {
    await page.locator('.conn-tab[data-tab="ble"]').click();
    await page.locator('#ble-connect-btn').click();
    await page.waitForFunction(() => window.bleSent.length >= 18 && !window.writeInProgress);
    await page.locator('#cue-mode').check();
    await page.waitForFunction(() => !document.getElementById('remote-play').disabled);
}

function sourceWave() {
    const bytes = Buffer.alloc(44 + 96000 + 32 + 84);
    const text = (at, value) => bytes.write(value, at, 'ascii');
    text(0, 'RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); text(8, 'WAVEfmt ');
    bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
    bytes.writeUInt32LE(48000, 24); bytes.writeUInt32LE(96000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
    text(36, 'data'); bytes.writeUInt32LE(96000, 40);
    let at = 96044; text(at, 'acid'); bytes.writeUInt32LE(24, at + 4); bytes.writeFloatLE(128, at + 28);
    at += 32; text(at, 'cue '); bytes.writeUInt32LE(76, at + 4); bytes.writeUInt32LE(3, at + 8);
    for (const [i, sample] of [0, 24000, 36000].entries()) {
        const cue = at + 12 + i * 24; bytes.writeUInt32LE(i + 1, cue); text(cue + 8, 'data'); bytes.writeUInt32LE(sample, cue + 20);
    }
    return bytes;
}

test('local WAV preparation preserves markers and BPM; Bluetooth cues drive matching and exact jumps', async t => {
    const page = await openApp(t, 'ble');
    await startRemote(page);
    await page.evaluate(() => window.emitTrack('My set.wav', 48000));
    await page.locator('#carrier-prepare-options summary').click();
    await page.locator('#carrier-file').setInputFiles({ name: 'My set.wav', mimeType: 'audio/wav', buffer: sourceWave() });
    await page.waitForFunction(() => !document.getElementById('carrier-download').disabled);
    const event = page.waitForEvent('download');
    await page.locator('#carrier-download').click();
    const download = await event;
    assert.equal(download.suggestedFilename(), 'My set.cue');
    const bytes = new Uint8Array(await fs.readFile(await download.path()));
    const blocks = carrierAudio.encode(carrierAudio.resample(bytes)).map(b => [...b]);
    await page.evaluate(blocks => { window.carrierBlocks = blocks; window.remoteRequests = []; }, blocks);
    await page.locator('#carrier-read').click();
    await page.waitForFunction(() => document.querySelectorAll('#carrier-cues button').length === 3);
    assert.equal(await page.locator('#tempo-source').inputValue(), '128');
    assert.match(await page.locator('#tempo-source-info').innerText(), /BPM from cue file/);
    assert.deepEqual(await page.evaluate(() => window.remoteRequests.map(r => r.data)), [[64]]);
    await page.locator('#carrier-cues button').nth(1).click();
    await page.waitForFunction(() => document.getElementById('carrier-status').textContent.includes('playback acknowledged'));
    assert.deepEqual(await page.evaluate(() => window.remoteRequests.slice(-3).map(r => r.data)), [[81], [76, 244, 1, 0, 0], [80]]);
    assert.equal(cueCarrier.decode(carrierAudio.resample(bytes), { filename: 'My set.wav', sampleRate: 48000, numFrames: 48000 }).bpm, 128);
});

async function carrierFixture(page, filename, cues, numFrames = 4800000, bpm = 128) {
    const source = { filename, sampleRate: 48000, numFrames, kind: 'wav', bpm, cues };
    const blocks = carrierAudio.encode(carrierAudio.resample(cueCarrier.makeWave(source).bytes)).map(b => [...b]);
    await page.evaluate(({ filename, numFrames, blocks }) => {
        window.carrierBlocks = blocks; window.emitTrack(filename, numFrames);
    }, { filename, numFrames, blocks });
}

async function reportPosition(page, ms, playing = true) {
    await page.evaluate(({ ms, playing }) => {
        window.emitCompanion([78, Number(playing)]);
        window.emitCompanion([77, ms & 255, ms >>> 8 & 255, ms >>> 16 & 255, ms >>> 24]);
    }, { ms, playing });
}

test('auto-load matches arbitrary exported names, waits for Stop and loads only once per selection', async t => {
    const page = await openApp(t, 'ble', true);
    await startRemote(page);
    const filename = 'Set 04 - żółć_音楽.final.v2.WAV';
    await carrierFixture(page, filename, [0, 480000, 960000]);
    await page.waitForTimeout(350);
    assert.equal(await page.evaluate(() => window.companionRequests.length), 0); // Unknown playback is not Stop.
    await reportPosition(page, 1000);
    await page.waitForTimeout(350);
    assert.equal(await page.evaluate(() => window.companionRequests.length), 0); // Do not interrupt music.
    await page.locator('#remote-stop').click();
    await page.waitForFunction(() => document.querySelectorAll('#carrier-cues button').length === 3);
    assert.match(await page.locator('#carrier-target').textContent(), /Set 04 - żółć_音楽.final.v2.cue/);
    const request = await page.evaluate(() => window.companionRequests.find(r => r.data[0] === 67).data);
    assert.deepEqual(request, [67, 0, ...new TextEncoder().encode(`recordings\0${filename.slice(0, -4)}.cue\0`)]);
    await reportPosition(page, 1000, false);
    await page.waitForTimeout(400);
    assert.equal(await page.evaluate(() => window.companionRequests.filter(r => r.data[0] === 67).length), 1);
    assert.equal(await page.evaluate(() => window.remoteRequests.some(r => r.data[0] === 80)), false);
    await carrierFixture(page, 'Another song 95bpm.wav', [0, 240000]);
    assert.equal(await page.locator('#carrier-cues button').count(), 0);
    assert.equal(await page.evaluate(() => window.tp7RemotePanel.getState().playing), null);
    await page.waitForTimeout(350);
    assert.equal(await page.evaluate(() => window.companionRequests.filter(r => r.data[0] === 67).length), 1);
    await reportPosition(page, 0, false);
    await page.waitForFunction(() => document.querySelectorAll('#carrier-cues button').length === 2);
    assert.equal(await page.evaluate(() => window.companionRequests.filter(r => r.data[0] === 67).length), 2);
    await page.locator('#carrier-options summary').click();
    await page.locator('#carrier-auto').uncheck();
    await page.locator('#carrier-follow').uncheck();
    await page.reload();
    assert.equal(await page.locator('#carrier-auto').isChecked(), false);
    assert.equal(await page.locator('#carrier-follow').isChecked(), false);
    assert.equal(await page.locator('#carrier-cues button').count(), 0);
});

test('auto-load failure does not loop; manual retry works and a changed track cancels a pending transfer', async t => {
    const page = await openApp(t, 'ble', true);
    await startRemote(page);
    await carrierFixture(page, 'wrong.wav', [0, 480000]);
    await page.evaluate(() => window.emitTrack('selected.wav', 4800000));
    await reportPosition(page, 0, false);
    await page.waitForFunction(() => document.getElementById('carrier-status').dataset.status === 'error');
    assert.match(await page.locator('#carrier-status').innerText(), /different track/);
    await reportPosition(page, 0, false);
    await page.waitForTimeout(400);
    assert.equal(await page.evaluate(() => window.companionRequests.filter(r => r.data[0] === 67).length), 1);
    await carrierFixture(page, 'selected.wav', [0, 480000]);
    await page.locator('#carrier-read').click();
    await page.waitForFunction(() => document.querySelectorAll('#carrier-cues button').length === 2);
    await page.evaluate(() => { window.companionMode = 'silent'; window.companionRequests = []; window.emitTrack('pending.wav'); });
    await reportPosition(page, 0, false);
    await page.waitForFunction(() => window.companionRequests.some(r => r.data[0] === 70));
    await page.evaluate(() => window.emitTrack('new selection.wav'));
    await page.waitForFunction(() => !window.tp7RemotePanel.getState().busy);
    assert.equal(await page.locator('#carrier-cues button').count(), 0);
    assert.match(await page.locator('#carrier-track').textContent(), /new selection.wav/);
    assert.equal(await page.evaluate(() => window.remoteRequests.some(r => r.data[0] === 80)), false);
});

test('loaded cues follow device positions, page changes and staleness without optimistic highlights', async t => {
    const page = await openApp(t, 'ble');
    await startRemote(page);
    await carrierFixture(page, 'DJ set - żółć.final.v2.wav', Array.from({ length: 40 }, (_, i) => i * 96000));
    await page.locator('#carrier-read').click();
    await page.waitForFunction(() => document.querySelectorAll('#carrier-cues button').length === 32);
    const current = page.locator('#carrier-cues [aria-current="step"]');
    const next = page.locator('#carrier-cues .is-next');
    await reportPosition(page, 6000);
    assert.equal(await current.getAttribute('data-index'), '3');
    assert.equal(await next.getAttribute('data-index'), '4');
    assert.match(await current.innerText(), /PLAYING/);
    await page.evaluate(() => { window.remoteMode = 'reject-seek'; });
    await page.locator('#carrier-cues button').nth(5).click();
    await page.waitForFunction(() => document.getElementById('carrier-status').dataset.status === 'error');
    assert.equal(await current.getAttribute('data-index'), '3');
    assert.match(await current.innerText(), /CURRENT POSITION/);
    await reportPosition(page, 66000);
    assert.equal(await page.locator('#carrier-page').innerText(), '2 / 2');
    assert.equal(await current.getAttribute('data-index'), '33');
    await page.locator('#carrier-prev').click();
    await reportPosition(page, 66500);
    assert.equal(await page.locator('#carrier-page').innerText(), '1 / 2'); // Browsing does not snap back on every packet.
    await reportPosition(page, 68000);
    assert.equal(await page.locator('#carrier-page').innerText(), '2 / 2');
    await page.locator('#carrier-follow').uncheck();
    await page.locator('#carrier-prev').click();
    await reportPosition(page, 70000);
    assert.equal(await page.locator('#carrier-page').innerText(), '1 / 2');
    await page.locator('#carrier-follow').check();
    assert.equal(await current.getAttribute('data-index'), '35');
    await reportPosition(page, 2000, false);
    await page.waitForTimeout(3500);
    assert.equal(await current.getAttribute('data-index'), '1'); // A confirmed stopped position is stable.
    await reportPosition(page, 2000);
    await page.waitForFunction(() => !document.querySelector('#carrier-cues [aria-current]'), undefined, { timeout: 5000 });
    assert.equal(await next.count(), 0);
    assert.match(await page.locator('#carrier-live').innerText(), /fresh TP-7 position/);
    await reportPosition(page, 100000);
    assert.equal(await current.count(), 0); // EOF is not the last playing section.
    await reportPosition(page, 2000);
    assert.equal(await current.getAttribute('data-index'), '1');
    for (const width of [320, 375, 768]) {
        await page.setViewportSize({ width, height: 1000 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    }
    await page.setViewportSize({ width: 375, height: 1000 });
    if (process.env.TP7_SCREENSHOT_DIR) await page.locator('#section-carrier').screenshot({ path: path.join(process.env.TP7_SCREENSHOT_DIR, 'active-cues-mobile.png') });
    await page.evaluate(() => window.emitTrack('other.wav'));
    assert.equal(await current.count(), 0);
    assert.equal(await next.count(), 0);
    assert.equal(await page.locator('#carrier-cues button').count(), 0);
    await page.evaluate(() => { bleDevice.gatt.connected = false; onBLEDisconnected(); });
    assert.equal(await page.locator('#carrier-read').isDisabled(), true);
});

test('legacy companion paths remain available; endpoint and empty marker lists cannot send stale jumps', async t => {
    const page = await openApp(t, 'ble');
    await startRemote(page);
    await page.locator('#carrier-options summary').click();
    await page.locator('#carrier-format').selectOption('legacy-wav');
    const source = { filename: 'example_cues_15_tempo_88.wav', sampleRate: 48000, numFrames: 4800000, kind: 'wav', bpm: 128, cues: [0, 4799999, 4800000] };
    const blocks = carrierAudio.encode(carrierAudio.resample(cueCarrier.makeWave(source).bytes)).map(b => [...b]);
    await page.evaluate(blocks => { window.carrierBlocks = blocks; }, blocks);
    await page.locator('#carrier-read').click();
    await page.waitForFunction(() => document.getElementById('carrier-source').textContent.includes('3 points'));
    assert.equal(await page.locator('#carrier-cues button').nth(0).isDisabled(), false);
    assert.equal(await page.locator('#carrier-cues button').nth(1).isDisabled(), true);
    assert.equal(await page.locator('#carrier-cues button').nth(2).isDisabled(), true);
    const request = await page.evaluate(() => window.companionRequests.find(r => r.data[0] === 67).data);
    assert.deepEqual(request, [67, 0, ...new TextEncoder().encode('recordings\0example_cues_15_tempo_88.tp7-cues.wav\0')]);
    await page.locator('#carrier-format').selectOption('cue');
    assert.equal(await page.locator('#carrier-cues button').count(), 0);
    const empty = carrierAudio.encode(carrierAudio.resample(cueCarrier.makeWave({ ...source, cues: [] }).bytes)).map(b => [...b]);
    await page.evaluate(blocks => { window.carrierBlocks = blocks; }, empty);
    await page.locator('#carrier-read').click();
    await page.waitForFunction(() => document.getElementById('carrier-source').textContent.includes('0 points'));
    assert.equal(await page.locator('#carrier-cues button').count(), 0);
    assert.equal(await page.locator('#remote-play').isDisabled(), false);
});

test('truncated helpers are rejected; padded helpers load all cues and their BPM', async t => {
    const page = await openApp(t, 'ble');
    await startRemote(page);
    const source = { filename: 'example_cues_15_tempo_88.wav', sampleRate: 48000, numFrames: 4800000,
        kind: 'wav', bpm: 95, cues: Array.from({ length: 17 }, (_, i) => i * 200001) };
    const padded = cueCarrier.makeWave(source, 'txt');
    const legacySamples = 14400 + (22 + cueCarrier.payload(source).length) * 960;
    const old = padded.bytes.slice(0, 44 + legacySamples * 2);
    new DataView(old.buffer).setUint32(4, old.length - 8, true);
    new DataView(old.buffer).setUint32(40, old.length - 44, true);
    const blocks = carrierAudio.encode(carrierAudio.resample(old), 4000).filter(b => b.length === 2003).slice(0, -1).map(b => [...b]);
    await page.evaluate(blocks => { window.carrierBlocks = blocks; }, blocks);
    await page.locator('#carrier-read').click();
    await page.waitForFunction(() => document.getElementById('carrier-status').textContent.includes('Regenerate'));
    assert.equal(await page.locator('#carrier-cues button').count(), 0);
    const complete = carrierAudio.encode(carrierAudio.resample(padded.bytes), 4000).filter(b => b.length === 2003).slice(0, -1).map(b => [...b]);
    await page.evaluate(blocks => { window.carrierBlocks = blocks; }, complete);
    await page.locator('#carrier-read').click();
    await page.waitForFunction(() => document.querySelectorAll('#carrier-cues button').length === 17);
    assert.equal(await page.locator('#tempo-source').inputValue(), '95');
});

test('carrier rejects a valid payload for a different track and cancellation restores the session', async t => {
    const page = await openApp(t, 'ble');
    await startRemote(page);
    const wrong = cueCarrier.makeWave({ filename: 'other.wav', sampleRate: 48000, numFrames: 4800000, kind: 'wav', bpm: null, cues: [0, 480000] });
    const blocks = carrierAudio.encode(carrierAudio.resample(wrong.bytes)).map(block => [...block]);
    await page.evaluate(blocks => { window.carrierBlocks = blocks; }, blocks);
    await page.locator('#carrier-read').click();
    await page.waitForFunction(() => document.getElementById('carrier-status').dataset.status === 'error');
    assert.match(await page.locator('#carrier-status').innerText(), /different track/);
    assert.equal(await page.locator('#carrier-cues button').count(), 0);
    assert.equal(await page.locator('#remote-play').isDisabled(), false);
    await page.evaluate(() => { window.companionMode = 'silent'; window.companionRequests = []; });
    await page.locator('#carrier-read').click();
    await page.waitForFunction(() => window.companionRequests.some(r => r.data[0] === 70));
    await page.locator('#carrier-cancel').click();
    await page.waitForFunction(() => document.getElementById('carrier-status').textContent.includes('cancelled'));
    assert.equal(await page.locator('#carrier-cues button').count(), 0);
    assert.equal(await page.locator('#remote-play').isDisabled(), false);
    const valid = cueCarrier.makeWave({ filename: 'example_cues_15_tempo_88.wav', sampleRate: 48000, numFrames: 4800000, kind: 'wav', bpm: null, cues: [0, 480000] });
    const validBlocks = carrierAudio.encode(carrierAudio.resample(valid.bytes)).map(block => [...block]);
    await page.evaluate(blocks => { window.carrierBlocks = blocks; window.companionMode = 'cleanup-fail'; }, validBlocks);
    await page.locator('#carrier-read').click();
    await page.waitForFunction(() => document.getElementById('carrier-status').textContent.includes('cleanup was not confirmed'));
    assert.equal(await page.locator('#carrier-cues button').count(), 0);
    assert.equal(await page.locator('#remote-play').isDisabled(), true);
});

test('DJ grid reads duration and filename BPM, then sends the exact selected position without changing speed', async t => {
    const page = await openApp(t, 'ble');
    await startRemote(page);
    await page.locator('#dj-enabled').check();
    await page.evaluate(() => {
        window.emitTrack('Multitrack_48k_5stems_tempo_88_cues_15.wav');
        window.emptySeekAck = true;
        window.remoteRequests = []; window.bleSent = [];
    });
    assert.equal(await page.locator('#dj-bpm').inputValue(), '88');
    assert.equal(await page.locator('#dj-grid button').count(), 15);
    assert.match(await page.locator('#dj-summary').innerText(), /2:43.177 · 88 BPM · 15 jumps/);
    assert.match(await page.locator('#remote-file-info').innerText(), /2:43.177 · 5 tracks/);
    assert.equal(await page.locator('#dj-grid button').last().getAttribute('data-position'), '152727');
    assert.equal(await page.locator('#tempo-source').inputValue(), '');
    assert.equal(await page.locator('#cue-count').inputValue(), '8');
    assert.deepEqual(await page.evaluate(() => window.remoteRequests), [], 'building the grid sends nothing');
    await page.locator('#dj-grid button').nth(1).click();
    await page.waitForFunction(() => document.getElementById('dj-action-status').dataset.status === 'sent');
    assert.deepEqual(await page.evaluate(() => window.remoteRequests.map(r => r.data)), [[81], [76, 157, 42, 0, 0], [80]]);
    assert.equal(await page.locator('#remote-position').innerText(), '0:10.909');
    assert.equal(await page.locator('#dj-grid [aria-current="step"]').getAttribute('data-index'), '1');
    const controls = await page.evaluate(() => window.bleSent.filter(packet => packet[2] !== 0xF0).map(packet => [packet.slice(2, 5), packet.slice(6, 9)]));
    assert.deepEqual(controls, [[[0xB0, 14, 0], [0xB0, 16, 0]]], 'no pitch, rocker or record-on commands');
});

test('DJ grid pages reach the end, fit mobile screens and preserve settings for each exact track', async t => {
    const page = await openApp(t, 'ble');
    await startRemote(page);
    await page.locator('#dj-enabled').check();
    await page.locator('#dj-bpm').fill('127,125');
    await page.locator('#dj-interval').selectOption('beat-quarter');
    await page.locator('#dj-meter').selectOption('3');
    const expected = require('../dj-cues.js').createGrid({ bpm: '127.125', interval: 'beat-quarter', beatsPerBar: 3, sampleRate: 48000, numFrames: 4800000 });
    assert.equal(await page.locator('#dj-grid button').count(), 32);
    await page.locator('#dj-page').fill(String(Math.ceil(expected.count / 32)));
    await page.locator('#dj-page').press('Enter');
    await page.locator('#dj-bpm').focus();
    assert.equal(await page.locator('#dj-grid button').last().getAttribute('data-position'), String(expected.pointAt(expected.count - 1).positionMs));
    assert.equal(await page.locator('#dj-next').isDisabled(), true);
    await page.locator('#dj-prev').click();
    assert.equal(await page.locator('#dj-grid button').count(), 32);
    // A different file, even with identical length, gets its own BPM.
    await page.evaluate(() => window.emitTrack('other.wav', 4800000));
    assert.equal(await page.locator('#dj-bpm').inputValue(), '');
    assert.equal(await page.locator('#dj-grid button').count(), 0);
    await page.locator('#dj-bpm').fill('95');
    await page.evaluate(() => window.emitTrack('example_cues_15_tempo_88.wav', 4800000));
    assert.equal(await page.locator('#dj-bpm').inputValue(), '127,125');
    assert.equal(await page.locator('#dj-meter').inputValue(), '3');
    assert.equal(await page.locator('#dj-interval').inputValue(), 'beat-quarter');
    // A reload keeps manual settings and still requires a new device session.
    await page.reload();
    assert.equal(await page.locator('#dj-grid button').count(), 0);
    await startRemote(page);
    await page.locator('#dj-enabled').check();
    assert.equal(await page.locator('#dj-bpm').inputValue(), '127,125');
    await page.locator('#dj-interval').selectOption('bar-4');
    for (const width of [320, 375, 768, 1280]) {
        await page.setViewportSize({ width, height: 1000 });
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `overflow at ${width}`);
        assert.ok((await page.locator('#dj-grid button').first().boundingBox()).height >= 44);
    }
    if (process.env.TP7_SCREENSHOT_DIR) {
        await page.evaluate(() => window.emitTrack('Multitrack_48k_5stems_tempo_88_cues_15.wav'));
        await page.locator('#section-dj').screenshot({ path: path.join(process.env.TP7_SCREENSHOT_DIR, 'dj-desktop.png') });
        await page.setViewportSize({ width: 375, height: 1100 });
        await page.locator('#section-dj').screenshot({ path: path.join(process.env.TP7_SCREENSHOT_DIR, 'dj-mobile.png') });
    }
    await page.evaluate(() => { bleDevice.gatt.connected = false; onBLEDisconnected(); });
    assert.equal(await page.locator('#dj-grid button').count(), 0);
    assert.equal(await page.locator('#dj-bpm').isDisabled(), true);
});

test('DJ changes cancel queued jumps; file changes and rejected seeks never resume', async t => {
    const page = await openApp(t, 'ble');
    await startRemote(page);
    await page.locator('#dj-enabled').check();
    await page.evaluate(() => { window.remoteRequests = []; window.holdWrite = true; });
    await page.locator('#cue-rec-off').click();
    await page.waitForFunction(() => window.releaseWrite !== null);
    await page.locator('#dj-grid button').nth(1).click();
    await page.locator('#dj-bpm').fill('90');
    await page.evaluate(async () => { window.releaseWrite(); await bleWriteQueue; });
    await page.waitForFunction(() => !window.tp7RemotePanel.getState().busy);
    assert.deepEqual(await page.evaluate(() => window.remoteRequests), []);
    await page.evaluate(() => { window.changeFileOnStop = true; });
    await page.locator('#dj-grid button').nth(1).click();
    await page.waitForFunction(() => !window.tp7RemotePanel.getState().busy);
    assert.deepEqual(await page.evaluate(() => window.remoteRequests.map(r => r.data)), [[81]]);
    assert.equal(await page.locator('#dj-grid button').count(), 0);
    await page.locator('#dj-bpm').fill('120');
    await page.evaluate(() => { window.remoteRequests = []; window.remoteMode = 'reject-seek'; });
    await page.locator('#dj-grid button').nth(1).click();
    await page.waitForFunction(() => document.getElementById('dj-action-status').dataset.status === 'error');
    assert.deepEqual(await page.evaluate(() => window.remoteRequests.map(r => r.data)), [[81], [76, 64, 31, 0, 0]]);
    assert.equal(await page.locator('#remote-playback').innerText(), 'Stopped');
});

test('USB Apply sends the optimum pitch once, is idempotent and survives reload', async t => {
    const page = await openApp(t);
    await enterTempo(page);
    assert.match(await page.locator('#tempo-result').innerText(), /127\.99804688 BPM/);
    await page.evaluate(() => { window.sent = []; });
    await page.locator('#tempo-apply').click();
    await page.waitForFunction(() => document.getElementById('tempo-result').dataset.status === 'sent');
    assert.deepEqual(await page.evaluate(() => window.sent), [[0xB0, 18, 64, 0xE0, 34, 68]]);
    assert.equal(await page.locator('#pitch-bend').inputValue(), '546');
    assert.equal(await page.locator('#pitch-manual').inputValue(), '546');
    assert.equal(await page.locator('#playmode-comp').isChecked(), true);
    await page.locator('#tempo-apply').click();
    assert.deepEqual(await page.evaluate(() => window.sent), [
        [0xB0, 18, 64, 0xE0, 34, 68], [0xB0, 18, 64, 0xE0, 34, 68],
    ]);
    await page.reload();
    await page.waitForFunction(() => window.sent.length >= 18);
    assert.equal(await page.locator('#pitch-bend').inputValue(), '546');
    assert.equal(await page.locator('#pitch-manual').inputValue(), '546');
    assert.ok((await page.evaluate(() => window.sent)).some(bytes => bytes.join() === '224,34,68'));
    assert.equal(await page.locator('#tempo-source').inputValue(), '', 'do not restore BPM for an unknown track');
});

test('invalid, disconnected and failed sends do not claim success', async t => {
    const page = await openApp(t);
    for (const value of ['0', '-1', '240', '120x']) {
        await enterTempo(page, '120', value);
        assert.equal(await page.locator('#tempo-apply').isDisabled(), true);
    }
    await enterTempo(page, '128', '120');
    await page.evaluate(() => { window.failSend = true; window.sent = []; });
    await page.locator('#tempo-apply').click();
    assert.match(await page.locator('#tempo-result').innerText(), /not confirmed sent.*USB failure/);
    assert.equal(await page.locator('#pitch-bend').inputValue(), '0');
    assert.deepEqual(await page.evaluate(() => window.sent), []);
    await page.evaluate(() => { window.failSend = false; });
    await page.locator('#tempo-apply').click();
    assert.equal(await page.locator('#pitch-bend').inputValue(), '-683');
    await page.locator('.pitch-preset[data-pitch="0"]').click();
    assert.match(await page.locator('#tempo-result').innerText(), /^Preview/);
    await page.evaluate(() => window.testDisconnect());
    assert.equal(await page.locator('#tempo-apply').isDisabled(), true);
});

test('BLE writes serialize, Apply is one packet, and failures can be retried', async t => {
    const page = await openApp(t, 'ble');
    await page.locator('.conn-tab[data-tab="ble"]').click();
    await page.locator('#ble-connect-btn').click();
    await page.waitForFunction(() => window.bleSent.length === 18 && !window.writeInProgress);
    await enterTempo(page);
    await page.locator('#tempo-apply').click();
    await page.waitForFunction(() => document.getElementById('tempo-result').dataset.status === 'sent');
    const packet = await page.evaluate(() => window.bleSent.at(-1));
    assert.equal(packet.length, 9);
    assert.ok(packet[0] >= 0x80 && packet[1] >= 0x80 && packet[5] >= 0x80);
    assert.deepEqual([...packet.slice(2, 5), ...packet.slice(6)], [0xB0, 18, 64, 0xE0, 34, 68]);
    await enterTempo(page, '128', '120');
    await page.evaluate(() => { window.failSend = true; });
    await page.locator('#tempo-apply').click();
    await page.waitForFunction(() => document.getElementById('tempo-result').dataset.status === 'error');
    assert.equal(await page.locator('#pitch-bend').inputValue(), '546');
    await page.evaluate(() => { window.failSend = false; });
    await page.locator('#tempo-apply').click();
    await page.waitForFunction(() => document.getElementById('tempo-result').dataset.status === 'sent');
    assert.equal(await page.locator('#pitch-bend').inputValue(), '-683');
});

test('editing BPM cancels a queued BLE Apply before it is transmitted', async t => {
    const page = await openApp(t, 'ble');
    await page.locator('.conn-tab[data-tab="ble"]').click();
    await page.locator('#ble-connect-btn').click();
    await page.waitForFunction(() => window.bleSent.length === 18 && !window.writeInProgress);
    await enterTempo(page);
    await page.evaluate(() => { window.holdWrite = true; window.bleSent = []; });
    await page.locator('.pitch-preset[data-pitch="0"]').click();
    await page.waitForFunction(() => !!window.releaseWrite);
    await page.locator('#tempo-apply').click();
    await page.locator('#tempo-target').fill('130');
    await page.evaluate(() => window.releaseWrite());
    await page.waitForFunction(() => !document.getElementById('tempo-apply').disabled);
    assert.equal(await page.evaluate(() => window.bleSent.length), 1);
    assert.equal(await page.locator('#pitch-bend').inputValue(), '0');
    assert.match(await page.locator('#tempo-result').innerText(), /^Preview/);
});

test('decimal comma, keyboard Apply and mobile tempo layout', async t => {
    const page = await openApp(t);
    await page.locator('#tempo-source').fill('127.125');
    await page.locator('#tempo-target').fill('127,125');
    await page.locator('#tempo-target').press('Enter');
    await page.waitForFunction(() => document.getElementById('tempo-result').dataset.status === 'sent');
    assert.equal(await page.locator('#pitch-bend').inputValue(), '0');
    await page.evaluate(() => { window.sent = []; });
    await page.locator('#tempo-apply').focus();
    await page.locator('#tempo-apply').press('Space');
    assert.deepEqual(await page.evaluate(() => window.sent), [[0xB0, 18, 64, 0xE0, 0, 64]]);
    await enterTempo(page);
    for (const width of [320, 375, 768, 1280]) {
        await page.setViewportSize({ width, height: 900 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `overflow at ${width}px`);
        const source = await page.locator('#tempo-source').boundingBox();
        const target = await page.locator('#tempo-target').boundingBox();
        assert.equal(source.y, target.y);
        assert.ok(target.x >= source.x + source.width);
    }
    if (process.env.TP7_SCREENSHOT_DIR) {
        await fs.mkdir(process.env.TP7_SCREENSHOT_DIR, { recursive: true });
        await page.locator('#section-tempo').screenshot({ path: path.join(process.env.TP7_SCREENSHOT_DIR, 'tempo-desktop.png') });
        await page.setViewportSize({ width: 375, height: 1100 });
        await page.locator('#section-tempo').screenshot({ path: path.join(process.env.TP7_SCREENSHOT_DIR, 'tempo-mobile.png') });
    }
});

test('Read from cue enables listening, waits for track metadata, reads BPM and preserves later manual edits', async t => {
    const page = await openApp(t, 'ble', true);
    assert.equal(await page.locator('#tempo-read-cue').innerText(), 'Read from cue');
    assert.equal(await page.locator('#tempo-file').count(), 0);
    await page.locator('.conn-tab[data-tab="ble"]').click();
    await page.locator('#ble-connect-btn').click();
    await page.waitForFunction(() => window.bleSent.length >= 18 && !window.writeInProgress);
    await carrierFixture(page, 'Current song.wav', [0, 480000], 4800000, 127.125);
    await page.evaluate(() => { window.sessionTrackDelay = 100; window.bleSent = []; });
    await enterTempo(page, '120', '130');
    await page.locator('#tempo-read-cue').click();
    await page.waitForFunction(() => document.getElementById('tempo-source').value === '127.125' && !document.getElementById('tempo-read-cue').disabled);
    assert.equal(await page.locator('#cue-mode').isChecked(), true);
    assert.equal(await page.locator('#carrier-cues button').count(), 2);
    assert.equal(await page.locator('#tempo-target').inputValue(), '130');
    assert.equal(await page.evaluate(() => window.companionRequests.filter(r => r.data[0] === 67).length), 1);
    assert.equal(await page.evaluate(() => window.remoteRequests.some(r => r.data[0] === 80)), false);
    assert.equal(await page.evaluate(() => window.bleSent.some(packet => packet[2] === 0xE0)), false);
    await page.locator('#carrier-options summary').click();
    await page.locator('#carrier-auto').uncheck();
    await carrierFixture(page, 'No BPM.wav', [0], 4800000, null);
    await page.locator('#tempo-read-cue').click();
    await page.waitForFunction(() => document.getElementById('tempo-source-info').textContent.includes('no BPM') && !document.getElementById('tempo-read-cue').disabled);
    assert.equal(await page.locator('#tempo-source').inputValue(), '');
    assert.equal(await page.locator('#tempo-apply').isDisabled(), true);
    await carrierFixture(page, 'Another song.wav', [0, 480000], 4800000, 95);
    await page.evaluate(() => { window.holdCarrier = true; window.finishCarrier = null; });
    await page.locator('#tempo-read-cue').click();
    await page.waitForFunction(() => typeof window.finishCarrier === 'function');
    await page.locator('#tempo-source').fill('121.5');
    await page.evaluate(() => window.finishCarrier());
    await page.waitForFunction(() => !document.getElementById('tempo-read-cue').disabled);
    assert.equal(await page.locator('#tempo-source').inputValue(), '121.5');
    assert.match(await page.locator('#tempo-source-info').innerText(), /Manual/);
});

test('Read from cue requires Bluetooth and keeps a manual BPM when disconnected', async t => {
    const page = await openApp(t, 'ble');
    await enterTempo(page);
    await page.locator('#tempo-read-cue').click();
    assert.match(await page.locator('#tempo-source-info').innerText(), /Connect TP-7 via Bluetooth/);
    assert.equal(await page.locator('#tempo-source').inputValue(), '120');
    assert.equal(await page.locator('#cue-mode').isChecked(), false);
    assert.equal(await page.evaluate(() => window.remoteRequests.length), 0);
});

test('notification failure sends no vendor command and preserves the original controls', async t => {
    const page = await openApp(t, 'ble');
    await page.locator('.conn-tab[data-tab="ble"]').click();
    await page.locator('#ble-connect-btn').click();
    await page.waitForFunction(() => window.bleSent.length === 18 && !window.writeInProgress);
    await page.evaluate(() => { window.failNotifications = true; });
    await page.locator('#cue-mode').check();
    await page.waitForFunction(() => document.getElementById('remote-status').dataset.status === 'error');
    assert.deepEqual(await page.evaluate(() => window.remoteRequests), []);
    await enterTempo(page);
    await page.locator('#tempo-apply').click();
    await page.waitForFunction(() => document.getElementById('tempo-result').dataset.status === 'sent');
});

test('compact UI requires cue opt-in, sends no diagnostic probes and only builds an enabled grid', async t => {
    const page = await openApp(t, 'ble');
    assert.equal(await page.locator('#cue-mode-content').isVisible(), false);
    assert.equal(await page.locator('#section-dj').isVisible(), false);
    assert.equal(await page.locator('#dj-grid button').count(), 0);
    assert.equal(await page.locator('#remote-report, #remote-seek, #companion-probe, #file-probe, #carrier-test').count(), 0);
    assert.deepEqual(await page.locator('#app > .section').evaluateAll(items => items.slice(0, 3).map(e => e.id)), ['section-connection', 'section-tempo', 'section-carrier']);
    await startRemote(page);
    assert.deepEqual(await page.evaluate(() => window.remoteRequests.map(r => [r.command, ...r.data])), [[1], [127, 64]]);
    assert.equal(await page.locator('#dj-grid button').count(), 0);
    await page.locator('#dj-enabled').check();
    assert.equal(await page.locator('#section-dj').isVisible(), true);
    assert.ok(await page.locator('#dj-grid button').count() > 0);
    await page.locator('#dj-enabled').uncheck();
    assert.equal(await page.locator('#dj-grid button').count(), 0);
    assert.equal(await page.locator('#section-dj').isVisible(), false);
    await page.locator('#remote-play').click();
    await page.waitForFunction(() => window.tp7RemotePanel.getState().playing === true);
    await page.locator('#remote-stop').click();
    await page.waitForFunction(() => window.tp7RemotePanel.getState().playing === false);
    await page.locator('#cue-mode').uncheck();
    await page.evaluate(() => window.emitTrack('ignored.wav'));
    assert.equal(await page.evaluate(() => window.tp7RemotePanel.getState().file), null);
    assert.equal(await page.locator('#cue-mode-content').isVisible(), false);
    for (const width of [320, 375, 768, 1280]) {
        await page.setViewportSize({ width, height: 1000 });
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    }
    if (process.env.TP7_SCREENSHOT_DIR) {
        await page.setViewportSize({ width: 375, height: 1100 });
        await page.screenshot({ path: path.join(process.env.TP7_SCREENSHOT_DIR, 'compact-mobile.png') });
    }
});

test('missing cue file is a single automatic attempt and a copied file can be reloaded', async t => {
    const page = await openApp(t, 'ble', true);
    await startRemote(page);
    await page.evaluate(() => { window.companionMode = 'missing-file'; });
    await reportPosition(page, 0, false);
    await page.waitForFunction(() => document.getElementById('carrier-status').textContent.includes('Cue file unavailable'));
    assert.equal(await page.locator('#carrier-cues button').count(), 0);
    assert.equal(await page.locator('#tempo-source').inputValue(), '');
    await reportPosition(page, 0, false);
    await page.waitForTimeout(400);
    assert.equal(await page.evaluate(() => window.companionRequests.filter(r => r.data[0] === 67).length), 1);
    await carrierFixture(page, 'example_cues_15_tempo_88.wav', [0, 480000]);
    await page.evaluate(() => { window.companionMode = 'ok'; });
    await page.locator('#carrier-read').click();
    await page.waitForFunction(() => document.querySelectorAll('#carrier-cues button').length === 2);
    assert.equal(await page.locator('#tempo-source').inputValue(), '128');
});

test('cue BPM cannot overwrite a manual edit during transfer or leak into the next track', async t => {
    const page = await openApp(t, 'ble');
    await startRemote(page);
    await carrierFixture(page, 'With BPM.wav', [0, 480000], 4800000, 95);
    await page.locator('#tempo-target').fill('130');
    await page.evaluate(() => { window.holdCarrier = true; });
    await page.locator('#carrier-read').click();
    await page.waitForFunction(() => typeof window.finishCarrier === 'function');
    await page.locator('#tempo-source').fill('121.5');
    await page.evaluate(() => { window.finishCarrier(); window.holdCarrier = false; });
    await page.waitForFunction(() => document.querySelectorAll('#carrier-cues button').length === 2);
    assert.equal(await page.locator('#tempo-source').inputValue(), '121.5');
    assert.match(await page.locator('#carrier-source').innerText(), /95/);
    await carrierFixture(page, 'Without BPM.wav', [0, 480000], 4800000, null);
    assert.equal(await page.locator('#tempo-source').inputValue(), '');
    assert.equal(await page.locator('#tempo-target').inputValue(), '130');
    await page.locator('#carrier-read').click();
    await page.waitForFunction(() => document.querySelectorAll('#carrier-cues button').length === 2);
    assert.equal(await page.locator('#tempo-source').inputValue(), '');
    assert.match(await page.locator('#tempo-source-info').innerText(), /no BPM/);
    assert.equal(await page.locator('#tempo-apply').isDisabled(), true);
    await carrierFixture(page, 'Pending.wav', [0, 480000]);
    await page.evaluate(() => { window.companionMode = 'silent'; window.companionRequests = []; });
    await page.locator('#carrier-read').click();
    await page.waitForFunction(() => window.companionRequests.some(r => r.data[0] === 70));
    await page.locator('#cue-mode').uncheck();
    await page.waitForFunction(() => !window.tp7RemotePanel.getState().busy && !window.tp7CompanionBusy);
    assert.equal(await page.locator('#carrier-cues button').count(), 0);
    assert.equal(await page.locator('#tempo-source').inputValue(), '');
    assert.equal(await page.evaluate(() => window.tp7RemotePanel.getState().ready), false);
});

test('a missing session acknowledgement keeps Play and cue reads disabled', async t => {
    const page = await openApp(t, 'ble');
    await page.locator('.conn-tab[data-tab="ble"]').click();
    await page.locator('#ble-connect-btn').click();
    await page.waitForFunction(() => window.bleSent.length >= 18 && !window.writeInProgress);
    await page.evaluate(() => { window.remoteMode = 'silent-session'; });
    await page.locator('#cue-mode').check();
    await page.waitForFunction(() => document.getElementById('remote-status').dataset.status === 'error');
    assert.equal(await page.locator('#remote-play').isDisabled(), true);
    assert.equal(await page.locator('#carrier-read').isDisabled(), true);
});

test('an expired device request is not sent after a stalled BLE queue resumes', async t => {
    const page = await openApp(t, 'ble');
    await page.locator('.conn-tab[data-tab="ble"]').click();
    await page.locator('#ble-connect-btn').click();
    await page.waitForFunction(() => window.bleSent.length === 18 && !window.writeInProgress);
    await page.evaluate(() => { window.holdWrite = true; });
    await page.locator('#cue-rec-off').click();
    await page.waitForFunction(() => window.releaseWrite !== null);
    await page.locator('#cue-mode').check();
    await page.waitForFunction(() => document.getElementById('remote-status').dataset.status === 'error');
    await page.evaluate(async () => { window.releaseWrite(); await bleWriteQueue; });
    assert.deepEqual(await page.evaluate(() => window.remoteRequests), []);
    assert.equal(await page.locator('#remote-play').isDisabled(), true);
});
