/**
 * Browser-repro backend — the high-fidelity, lower-scale path.
 *
 * Runs each client in a REAL Chromium tab (real WebSocket, real rAF, real event
 * loop) booting the SAME client pipeline as the worker backend, but against the
 * visible-tab animation code the headless worker skips. Reuses the shared
 * comparator (DesyncTracker) and drive logic, so a desync is confirmed
 * identically. Capped low (browsers are heavy) — this is for confirming a
 * worker-found desync with the authentic trigger, not 100s of games.
 *
 * Faults are not injected here (the value is the real browser, not simulated
 * loss); use the worker backend for fault sweeps.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, normalize, extname } from 'node:path';
import { chromium } from '@playwright/test';
import { makeRng } from '../../../../src/scripts/core/game-driver.js';
import { DesyncTracker } from '../../comparator.mjs';
import { makeActor } from '../../drive.mjs';
import { fixtureHtml } from '../worker/dom-fixture.mjs';

const SRC_ROOT = new URL('../../../../src/', import.meta.url).pathname;
const BOOT_FILE = new URL('./page-boot.js', import.meta.url).pathname;

const MIME = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };

const PAGE_HTML = () => `<!doctype html><html><head><meta charset="utf-8"><title>soak</title></head><body>
<script>try{localStorage.setItem('sound-muted','true')}catch(e){}</script>
${fixtureHtml()}
<script type="module" src="/__soak/boot.mjs"></script>
</body></html>`;

function startStaticServer() {
    const server = createServer(async (req, res) => {
        try {
            const url = new URL(req.url, 'http://localhost');
            if (url.pathname === '/__soak/page.html') { return send(res, 200, '.html', PAGE_HTML()); }
            if (url.pathname === '/__soak/boot.mjs') { return send(res, 200, '.mjs', await readFile(BOOT_FILE)); }
            // Serve any app file from the web root (src/), blocking traversal.
            const rel = normalize(url.pathname).replace(/^(\.\.[/\\])+/, '');
            const file = join(SRC_ROOT, rel);
            if (!file.startsWith(SRC_ROOT)) { res.writeHead(403); return res.end('no'); }
            const body = await readFile(file);
            send(res, 200, extname(file), body);
        } catch {
            res.writeHead(404); res.end('not found');
        }
    });
    return new Promise((resolve) => server.listen(0, () => resolve({ server, port: server.address().port })));
}

function send(res, code, ext, body) {
    res.writeHead(code, { 'content-type': MIME[ext] || 'application/octet-stream' });
    res.end(body);
}

export async function runBrowserSoak(config, reporter) {
    reporter.setMeta({ env: config.env, serverUrl: config.serverUrl, config });
    const { server, port } = await startStaticServer();
    const base = `http://localhost:${port}`;
    const browser = await chromium.launch({ headless: true });
    const concurrency = Math.min(config.concurrentGames, 3); // browsers are heavy

    if (!config.quiet) {
        console.log(`soak[browser]: ${config.env} (${config.serverUrl})  games=${config.totalRuns}  concurrency=${concurrency}  players=${config.playersPerGame}/${config.roomSize}`);
    }

    let launched = 0;
    let completed = 0;
    const inFlight = new Set();

    const launch = () => {
        const idx = launched++;
        const room = `BR${String(config.runStamp).replace(/[^0-9A-Za-z]/g, '').slice(-5)}${idx.toString(36).toUpperCase()}`;
        const onFrame = config.logFrames ? reporter.frameWriter(room) : undefined;
        const p = runBrowserGame(browser, base, config, room, config.seed + idx, onFrame)
            .then((res) => reporter.recordGame(res, completed++, config.totalRuns))
            .catch((err) => reporter.recordGame({ room, seed: config.seed + idx, frameCount: 0, turns: 0, error: String(err && err.stack || err), failed: true, failReason: 'browser-throw', confirmed: [] }, completed++, config.totalRuns))
            .finally(() => inFlight.delete(p));
        inFlight.add(p);
    };

    while (launched < config.totalRuns || inFlight.size) {
        while (inFlight.size < concurrency && launched < config.totalRuns) launch();
        if (inFlight.size) await Promise.race(inFlight);
    }

    await browser.close();
    server.close();
    return reporter.finalize();
}

async function runBrowserGame(browser, base, config, room, seed, onFrame) {
    const actor = makeActor(makeRng((seed >>> 0) ^ 0x1234567), config.movePolicy);
    const result = { room, seed, players: config.playersPerGame, roomSize: config.roomSize, started: false, ended: false, endReason: null, turns: 0, frameCount: 0, faults: 0, confirmed: [], failed: false, failReason: null, stalled: false, error: null };

    const pages = [];           // { ctx, page, seat, tracker, recent }
    const seatToPage = new Map();
    let finished = false;
    let resolveDone;
    const done = new Promise((r) => { resolveDone = r; });
    const endedPages = new Set();

    const finish = (reason) => {
        if (finished) return;
        finished = true;
        result.endReason = result.endReason || reason;
        resolveDone();
    };
    const timeout = setTimeout(() => { result.stalled = true; result.failed = true; result.failReason = 'timeout'; finish('guard'); }, config.gameTimeoutMs);

    function confirm(seat, recs, obs, atEnd) {
        for (const rec of recs) {
            const sig = `${seat}|${rec.mismatch.field}:${rec.mismatch.seat ?? ''}`;
            if (result.confirmed.some((c) => c._sig === sig)) continue;
            result.confirmed.push({ _sig: sig, room, seed, seat, atEnd, persisted: rec.persisted, reason: obs.reason, mismatch: rec.mismatch, allMismatches: rec.allMismatches, server: compact(obs.server), client: obs.client, faulted: false });
            result.failed = true;
            result.failReason = result.failReason || 'desync';
        }
    }

    async function handle(pg, msg) {
        switch (msg.type) {
            case 'seated':
                pg.seat = msg.seat;
                seatToPage.set(msg.seat, pg);
                break;
            case 'started':
                result.started = true;
                break;
            case 'frame': {
                result.frameCount++;
                if (typeof msg.turn === 'number' && msg.turn > result.turns) result.turns = msg.turn;
                onFrame?.(msg);
                if (finished || msg.phase === 'ENDED') { if (msg.phase === 'ENDED') result.ended = true; break; }
                const action = actor(msg, new Set(seatToPage.keys()));
                const target = seatToPage.get(msg.cur);
                if (action && target) {
                    if (action.cmd === 'roll') target.page.evaluate(() => window.__soakRoll()).catch(() => {});
                    else target.page.evaluate((t) => window.__soakMove(t), action.token).catch(() => {});
                }
                if (result.turns > config.maxTurns) { result.stalled = true; result.failed = true; result.failReason = 'max-turns'; finish('guard'); }
                break;
            }
            case 'observation': {
                pg.recent.push({ seq: msg.seq, reason: msg.reason, server: compact(msg.server), client: msg.client });
                if (pg.recent.length > 12) pg.recent.shift();
                const obs = { server: msg.server, client: msg.client, reason: msg.reason };
                confirm(pg.seat, pg.tracker.observe(obs), obs, false);
                if (msg.ended) confirm(pg.seat, pg.tracker.finalize(obs), obs, true);
                break;
            }
            case 'ended':
                result.ended = true;
                endedPages.add(pg.seat);
                if (endedPages.size >= pages.length && pages.every((p) => p.seat !== -1)) finish('finished');
                break;
            case 'busy':
                result.failed = true; result.failReason = `busy:${msg.reason}`; finish('busy');
                break;
            case 'pipeline-error':
                result.error = msg.message; result.failed = true; result.failReason = 'pipeline-error';
                break;
            default: break;
        }
    }

    try {
        for (let i = 0; i < config.playersPerGame; i++) {
            const ctx = await browser.newContext();
            const page = await ctx.newPage();
            const pg = { ctx, page, seat: -1, tracker: new DesyncTracker({ strictness: config.strictness, convergenceFrames: config.convergenceFrames }), recent: [] };
            pages.push(pg);
            await page.exposeBinding('__soakEmit', (_src, payload) => handle(pg, payload));
            const params = new URLSearchParams({ server: config.serverUrl, room, session: `${room}-p${i}`, name: `P${i + 1}`, size: String(config.roomSize), seed: String(seed), flushTicks: String(config.flushTicks + 2) });
            await page.goto(`${base}/__soak/page.html?${params}`);
            // Host first: wait for its seat before the joiners connect (R5).
            await waitForSeat(pg, config.gameTimeoutMs);
        }
        await pages[0].page.evaluate(() => window.__soakStart());
    } catch (e) {
        result.error = String(e && e.stack || e); result.failed = true; result.failReason = 'spawn-error'; finish('guard');
    }

    async function waitForSeat(pg, ms) {
        const start = Date.now();
        while (pg.seat === -1 && Date.now() - start < Math.min(ms, 15000)) await new Promise((r) => setTimeout(r, 50));
    }

    await done;
    clearTimeout(timeout);
    for (const pg of pages) { try { await pg.ctx.close(); } catch {} }
    return result;
}

function compact(s) {
    if (!s) return null;
    return { phase: s.phase, turn: s.turn, currentPlayerIndex: s.currentPlayerIndex, dice: s.dice, legalMoves: s.legalMoves, positions: s.positions, playerTypes: s.playerTypes, ranks: s.ranks };
}
