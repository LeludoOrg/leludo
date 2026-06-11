/**
 * GameRunner — drives ONE private match to completion and reports any desync.
 *
 * Lifecycle (R5 host/joiner race): connect the host worker first and wait for its
 * `seated`, then connect the joiners (private-room config — size/seed — is read
 * only when the room is created, so the host must win that race). Once all human
 * workers are seated, the host sends LOBBY_START. Turns are then driven off the
 * SERVER frames (the turn authority): when it's one of our human seats' turn we
 * tell that worker to roll/move; bot seats are driven by the server.
 *
 * Each worker streams compact `frame` records (the per-step server log) plus
 * settled `observation`s (server truth + that client's belief). The runner runs
 * the comparator on every observation and collects confirmed desyncs.
 */
import { Worker } from 'node:worker_threads';
import { makeRng } from '../../src/scripts/core/game-driver.js';
import { makeActor } from './drive.mjs';

const WORKER_ENTRY = new URL('./backends/worker/client-worker.mjs', import.meta.url);

/**
 * @param {object} cfg
 * @param {string} cfg.url
 * @param {string} cfg.room
 * @param {number} cfg.seed
 * @param {number} cfg.players        human workers we drive
 * @param {number} cfg.roomSize       total active seats (rest fill with bots)
 * @param {object} [cfg.faults]       per-client fault config (applied to seat 0..)
 * @param {number[]} [cfg.faultSeats] which human seats get faults (default none)
 * @param {string} cfg.strictness
 * @param {number} cfg.convergenceFrames
 * @param {string} cfg.movePolicy
 * @param {number} cfg.settleMs
 * @param {boolean} cfg.hidden
 * @param {number} cfg.maxTurns
 * @param {number} cfg.gameTimeoutMs
 * @param {(frame:object)=>void} [cfg.onFrame]   stream per-frame server record
 * @param {(info:object)=>void} [cfg.onFault]
 * @returns {Promise<object>} GameResult
 */
export async function runGame(cfg) {
    const actor = makeActor(makeRng((cfg.seed >>> 0) ^ 0x1234567), cfg.movePolicy);
    const faultSeats = new Set(cfg.faultSeats || []);

    const result = {
        room: cfg.room,
        seed: cfg.seed,
        players: cfg.players,
        roomSize: cfg.roomSize,
        started: false,
        ended: false,
        endReason: null,
        turns: 0,
        frameCount: 0,
        faults: 0,
        confirmed: [],         // confirmed desyncs (repro bundles)
        failed: false,
        failReason: null,
        stalled: false,
        error: null,
    };

    const workers = [];           // { worker, index, seat, faultConfig }
    const seatToWorker = new Map();

    // Reconnect fault: force `count` mid-game socket drops on the faulted seats,
    // the first at turn `atTurn`, then every `everyTurns`. NetClient auto-rejoins
    // and the server replays a reason:'reconnect' catch-up snapshot.
    const reconnect = cfg.faults?.reconnect || null;
    const reconnectTargets = faultSeats.size ? [...faultSeats] : [0];
    let reconnectsDone = 0;
    let nextReconnectTurn = reconnect?.atTurn ?? Infinity;

    let finished = false;
    let resolveDone;
    const done = new Promise((r) => { resolveDone = r; });
    const endedWorkers = new Set();
    let endFallback = null;

    const finish = (reason) => {
        if (finished) return;
        finished = true;
        if (endFallback) clearTimeout(endFallback);
        result.endReason = result.endReason || reason;
        for (const w of workers) { try { w.worker.postMessage({ cmd: 'close' }); } catch {} }
        setTimeout(() => {
            for (const w of workers) { try { w.worker.terminate(); } catch {} }
            resolveDone();
        }, 150);
    };

    // Game-over: each worker runs an end-grace final check then ships `ended`.
    // Tear down only once every worker has finished that check (or a fallback
    // fires), so a worker's authoritative end comparison is never cut off.
    const noteWorkerEnded = (seat) => {
        endedWorkers.add(seat);
        if (!endFallback) endFallback = setTimeout(() => finish('finished'), 5000);
        if (endedWorkers.size >= workers.length && workers.every((w) => w.seat !== -1)) finish('finished');
    };

    const timeout = setTimeout(() => { result.stalled = true; result.failed = true; result.failReason = 'timeout'; finish('guard'); }, cfg.gameTimeoutMs);

    function handleMessage(w, msg) {
        switch (msg.type) {
            case 'seated':
                w.seat = msg.seat;
                seatToWorker.set(msg.seat, w);
                break;
            case 'started':
                result.started = true;
                break;
            case 'frame':
                result.frameCount++;
                if (typeof msg.turn === 'number' && msg.turn > result.turns) result.turns = msg.turn;
                cfg.onFrame?.(msg);
                drive(msg);
                maybeReconnect(msg.turn);
                if (msg.phase === 'ENDED') result.ended = true; // wait for workers' final check
                if (result.turns > cfg.maxTurns) { result.stalled = true; result.failed = true; result.failReason = 'max-turns'; finish('guard'); }
                break;
            case 'desync':
                confirm(msg);
                break;
            case 'ended':
                result.ended = true;
                noteWorkerEnded(w.seat);
                break;
            case 'busy':
                result.failed = true; result.failReason = `busy:${msg.reason}`; finish('busy');
                break;
            case 'fault':
                result.faults++;
                cfg.onFault?.(msg);
                break;
            case 'boot-error':
            case 'pipeline-error':
                result.error = msg.message;
                result.failed = true; result.failReason = msg.type;
                break;
            case 'rejected':
                // Out-of-turn/duplicate intents are rejected harmlessly; ignore.
                break;
            default:
                break;
        }
    }

    function drive(frame) {
        if (finished || frame.phase === 'ENDED') return;
        const w = seatToWorker.get(frame.cur);
        if (!w) return; // bot seat — the server drives it
        const action = actor(frame, new Set(seatToWorker.keys()));
        if (action) { try { w.worker.postMessage(action); } catch {} }
    }

    function maybeReconnect(turn) {
        if (!reconnect || finished || typeof turn !== 'number') return;
        if (reconnectsDone >= (reconnect.count || 1) || turn < nextReconnectTurn) return;
        const seat = reconnectTargets[reconnectsDone % reconnectTargets.length];
        const w = seatToWorker.get(seat);
        if (w) { try { w.worker.postMessage({ cmd: 'forceReconnect' }); } catch {} }
        reconnectsDone++;
        nextReconnectTurn = turn + (reconnect.everyTurns || 12);
    }

    function confirm(msg) {
        // Workers already apply persistence; de-dup one record per (seat, signature).
        const sig = `${msg.seat}|${msg.sig}`;
        if (result.confirmed.some((c) => c._sig === sig)) return;
        result.confirmed.push({
            _sig: sig,
            room: cfg.room, seed: cfg.seed, seat: msg.seat, seq: msg.seq,
            reason: msg.reason, atEnd: msg.atEnd, persisted: msg.persisted,
            mismatch: msg.mismatch, allMismatches: msg.allMismatches,
            faulted: faultSeats.has(msg.seat),
            server: msg.server, client: msg.client, recent: msg.recent,
        });
        result.failed = true;
        result.failReason = result.failReason || 'desync';
    }

    try {
        // --- host first, then joiners (R5) ---
        const baseParams = { size: String(cfg.roomSize), seed: String(cfg.seed) };
        for (let i = 0; i < cfg.players; i++) {
            const faultConfig = faultSeats.has(i) || (faultSeats.size === 0 && cfg.faultsAll) ? cfg.faults : undefined;
            const w = {
                index: i,
                seat: -1,
                worker: new Worker(WORKER_ENTRY, {
                    workerData: {
                        url: cfg.url,
                        room: cfg.room,
                        session: `${cfg.room}-p${i}`,
                        name: `P${i + 1}`,
                        params: baseParams,
                        faultConfig,
                        seed: cfg.seed + i,
                        hidden: cfg.hidden,
                        strictness: cfg.strictness,
                        convergenceFrames: cfg.convergenceFrames,
                        flushTicks: cfg.flushTicks,
                    },
                }),
            };
            w.worker.on('message', (msg) => handleMessage(w, msg));
            w.worker.on('error', (e) => { result.error = String(e && e.stack || e); result.failed = true; result.failReason = 'worker-error'; finish('guard'); });
            workers.push(w);
            // Wait for THIS worker's seat before connecting the next, so the host
            // (i===0) creates the room before any joiner can.
            await waitForSeat(w);
        }

        // All seated → host starts. The host is the first to join (seat-claimed
        // host); find whichever worker reported isHost, else fall back to index 0.
        const host = workers[0];
        host.worker.postMessage({ cmd: 'start' });
    } catch (e) {
        result.error = String(e && e.stack || e);
        result.failed = true;
        result.failReason = 'spawn-error';
        finish('guard');
    }

    function waitForSeat(w) {
        return new Promise((resolve) => {
            if (w.seat !== -1) return resolve();
            const onMsg = (msg) => { if (msg.type === 'seated') { w.worker.off('message', onMsg); resolve(); } };
            w.worker.on('message', onMsg);
            // Safety: don't hang forever if a seat never arrives.
            setTimeout(resolve, Math.min(cfg.gameTimeoutMs, 10000));
        });
    }

    await done;
    clearTimeout(timeout);
    return result;
}
