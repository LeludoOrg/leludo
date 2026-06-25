/**
 * LudoRoomDO — one Durable Object instance per game, the authoritative state.
 *
 * Thin transport shell over the runtime-agnostic RoomEngine (server/room-engine.js).
 * It is the CF twin of the per-room block in server/local-server.mjs: same
 * engine, same `transport` contract ({broadcast, send, release}), same intent
 * switch. All rules live in scripts/* — this only moves bytes and owns sockets.
 *
 * Memory model — RESIDENT, NOT hibernated (deliberate).
 *   The engine keeps live state (board, RNG stream, bot/grace setTimeout timers)
 *   in this instance's memory. We accept WebSockets with `server.accept()`
 *   (standard, not the Hibernation API) so the runtime keeps the DO resident
 *   while ≥1 client is connected — exactly like the Node process the engine was
 *   written for, so its plain setTimeout-based bot pacing and reconnect grace
 *   work without change.
 *
 *   We tried WebSocket Hibernation (v0.24.5) to cut idle duration (GB-s), but it
 *   forced a snapshot write to storage on EVERY broadcast (so state survives
 *   eviction) and CF's output gate then held each roll/move frame until that
 *   write landed — visible per-action lag — while a cold wake on the first move
 *   after a player's think-time added more. On the FREE plan the binding limit is
 *   SQL rows-written, NOT duration (idle 2p ≈ 0.4 GB-s; duration never binds), so
 *   the snapshot writes were inflating the cost dimension that actually binds AND
 *   hurting latency. Reverting to resident sockets removed the latency. The
 *   duration cost of staying resident through human think-time is real but
 *   unbilled on free.
 *
 * Deploy survival — RESIDENT but PERSISTED (v0.28.5).
 *   A code deploy (or DO migration) shuts the instance down regardless of how it
 *   holds sockets — in-memory state is wiped and every WebSocket terminated (true
 *   even for hibernated sockets), so a continuous-deployment cadence would
 *   otherwise end every live game. We now write a resume snapshot on every
 *   state-changing broadcast (the engine's `persist` hook → GAME_KEY) and rebuild
 *   from it on a cold reconnect (_restore). The latency that sank hibernation is
 *   avoided by writing with `{ allowUnconfirmed: true }` — the write stays OFF the
 *   output gate, so frames go out instantly; a snapshot lost to a crash just means
 *   the next reconnect re-syncs from the prior frame. The cost is the snapshot
 *   rows reappearing (~570 rows/2p, ~1668/4p — see wrangler.toml), which the
 *   per-day game caps were already sized to keep under the free-tier 100k/day.
 *
 * Leak guard: when the last socket closes mid-game (every client dropped at
 * once), the DO can be evicted and its in-memory grace timers lost — which would
 * leak the admission slot. A storage alarm armed on the zero-connection
 * transition force-releases the slot if nobody reconnects within the grace
 * window. (A room that empties cleanly already ends + releases synchronously via
 * the engine, so the alarm only fires for the simultaneous-drop edge.) The room
 * id is persisted alongside that alarm so a cold instance (evicted before the
 * alarm fires) can still release the right slot — its in-memory roomId is gone.
 *
 * Room teardown: a released room drops its in-memory engine (see _release). The
 * resident DO is reused across games on the same code, so a lingering ended /
 * abandoned engine would make a fresh join-by-code hit "no open seat" (ROOM_FULL)
 * instead of "no such room" (ROOM_NOT_FOUND). Nulling the engine on release keeps
 * the DO in lockstep with the Node twin, which deletes the room outright.
 */
import { RoomEngine, PHASES } from '../room-engine.js';
import { clampSeats, numEnv, randomSeed, safeSend, safeParse, wsReject, ADMISSION_NAME, requireWebsocket } from './cf-utils.js';
import { MSG, ERR } from '../../scripts/net/net-protocol.js';
import { SessionSockets, engineTransport, dispatchIntent, parseConnParams } from '../transport-shell.js';

// Storage key for the room id, persisted only when the room empties (see
// _onClose). A cold instance woken by alarm() after eviction has no in-memory
// this.roomId, so it reads this to release the right admission slot.
const ROOM_KEY = 'roomId';

// Storage key for the full engine snapshot. Written on every state-changing
// broadcast (see the persist hook in _ensureEngine) so a cold instance — one the
// runtime evicted on a code deploy or DO migration — can rebuild the live game
// on reconnect instead of forcing ROOM_NOT_FOUND / a ghost lobby (see _restore).
const GAME_KEY = 'game';

export class LudoRoomDO {
    constructor(state, env) {
        this.state = state;
        this.env = env;
        this.engine = null;
        this.roomId = null;
        this.admitted = false;   // this room has consumed an admission slot
        this.released = false;   // ...and given it back (idempotent)
        // sessionId -> Set<WebSocket>. CF sends pre-stringified frames, so the
        // injected primitive stringifies before the error-swallowing safeSend.
        this.sockets = new SessionSockets((ws, msg) => safeSend(ws, JSON.stringify(msg)));
        this.graceMs = numEnv(env.RECONNECT_GRACE_MS, 60_000);
    }

    _admissionStub() {
        return this.env.ADMISSION.get(this.env.ADMISSION.idFromName(ADMISSION_NAME));
    }

    _ensureEngine(cfg) {
        if (this.engine) return;
        this.engine = new RoomEngine({
            roomId: this.roomId,
            size: cfg.size,
            botNamePool: cfg.pool,
            graceMs: this.graceMs,
            // Fresh per-room dice stream — prod must NOT be the fixed seed the dev
            // harness uses, or every game would roll an identical sequence. (On the
            // restore path _restore overwrites the whole engine state, this seed
            // included, via engine.restore — so a resumed game keeps its own stream.)
            seed: randomSeed(),
            transport: engineTransport(this.sockets, () => this.engine, () => this._release()),
            // Survive eviction. A code deploy (or DO migration) shuts the instance
            // down and wipes in-memory state — including the engine (see header) —
            // and terminates every WebSocket; clients then reconnect into a COLD
            // instance. Persist the full authoritative snapshot on every
            // state-changing broadcast so that cold instance can rebuild the live
            // game in _restore. `allowUnconfirmed` keeps the write OFF Cloudflare's
            // output gate, so broadcast frames go out instantly (no per-action lag):
            // a snapshot lost to a crash just means the next reconnect re-syncs from
            // the prior frame, which is acceptable — this is the non-gating async
            // persist the header flagged as the safe way to bring persistence back.
            persist: (engine) => {
                this.state.storage
                    .put(GAME_KEY, engine.serialize(), { allowUnconfirmed: true })
                    .catch(() => { /* best-effort; the next broadcast rewrites it */ });
            },
        });
    }

    /**
     * Rebuild the engine from the last persisted snapshot after the runtime
     * evicted this instance (a code deploy or DO migration; see header). No-op
     * when the engine is already warm, when nothing was saved, when the snapshot
     * is from a schema this build can't resume (`v` mismatch), or when the game
     * already ended — a finished room must read GONE, never resurrect.
     *
     * A restored room was admitted BEFORE eviction and the AdmissionDO persists
     * its own counters, so the slot is still counted there: adopt it WITHOUT a
     * second admit round-trip, which would double-count the game against the cap.
     */
    async _restore() {
        if (this.engine) return;
        let snap;
        try { snap = await this.state.storage.get(GAME_KEY); } catch { return; }
        if (!snap || snap.v !== 1 || snap.phase === PHASES.ENDED) return;
        this.roomId = snap.roomId || this.roomId;
        this.admitted = true;
        this.released = false;
        this._ensureEngine({ size: 2, pool: snap.botNamePool });
        this.engine.restore(snap);
        // Re-arm the timers that lived only in the evicted instance's memory:
        // disconnect-grace forfeits resume from their persisted deadlines (firing
        // at once if the window lapsed while we were down), and a bot left mid-turn
        // gets its paced step re-kicked.
        this.engine._resumeTimers();
    }

    async fetch(request) {
        const notWs = requireWebsocket(request);
        if (notWs) return notWs;

        const p = parseConnParams(new URL(request.url).searchParams);
        this.roomId = p.room.toUpperCase();
        const sessionId = p.session || `anon-${crypto.randomUUID()}`;
        const { name, color, pool } = p;
        const size = clampSeats(p.sizeRaw, 2);

        // Cold instance after an eviction (a code deploy / DO migration shuts the
        // DO down — see header)? Rebuild the live game from its persisted snapshot
        // BEFORE the join/admission checks, so a reconnect resumes the match rather
        // than hitting ROOM_NOT_FOUND (joiner) or minting a fresh ghost lobby
        // (host/create). No-op for a genuinely new room (nothing saved).
        if (!this.engine) await this._restore();

        // Join-by-code into a room that doesn't exist: a resident DO only holds
        // `this.engine` while its host is connected (or within the eviction-free
        // life of the room), and _restore above failed to rebuild one, so a missing
        // engine on a `join=1` connect means no host ever created this code (or the
        // room ended / its snapshot is gone). Refuse instead of auto-creating a
        // ghost room — and do it BEFORE the admission round-trip so a typo'd code
        // can't burn a slot. `create=1` (and any non-join connect, e.g. a
        // public-match redial) still falls through to _ensureEngine below.
        if (!this.engine && p.join) {
            return wsReject({ t: MSG.ERROR, error: ERR.ROOM_NOT_FOUND });
        }

        // First connection to this room consumes an admission slot; later joiners
        // ride the already-open room (Admission treats a re-admit of a live room
        // as a free no-op, but we skip the round-trip entirely once admitted).
        if (!this.admitted) {
            const res = await this._admissionStub().fetch(
                `https://do/admit?room=${encodeURIComponent(this.roomId)}`,
            );
            const verdict = await res.json();
            if (!verdict.ok) return wsReject({ t: MSG.BUSY, reason: verdict.reason });
            this.admitted = true;
            this.released = false;
        }

        this._ensureEngine({ size, pool });

        const pair = new WebSocketPair();
        const client = pair[0];
        const server = pair[1];
        server.accept();
        // A new connection cancels any pending zero-connection cleanup.
        this.state.storage.deleteAlarm().catch(() => {});

        this.sockets.add(sessionId, server);

        const joined = this.engine.handleJoin(sessionId, name, color);
        if (!joined.ok) safeSend(server, JSON.stringify({ t: MSG.ERROR, error: joined.error }));

        server.addEventListener('message', (ev) => {
            const msg = safeParse(ev.data);
            if (!msg) return;
            this._onMessage(sessionId, msg);
        });
        const onGone = () => this._onClose(sessionId, server);
        server.addEventListener('close', onGone);
        server.addEventListener('error', onGone);

        return new Response(null, { status: 101, webSocket: client });
    }

    _onMessage(sessionId, msg) {
        if (this.engine) dispatchIntent(this.engine, sessionId, msg);
    }

    _onClose(sessionId, ws) {
        if (this.sockets.remove(sessionId, ws)) this.engine?.handleDisconnect(sessionId);
        // Last socket gone → arm the leak-guard alarm (see header). If a fully
        // empty room hasn't already ended+released synchronously, the alarm
        // releases the slot once the grace window lapses with nobody back. Persist
        // the room id with it so a cold instance (evicted before the alarm fires)
        // still knows which slot to release.
        if (this.sockets.size === 0 && !this.released) {
            this.state.storage.put(ROOM_KEY, this.roomId).catch(() => {});
            this.state.storage.setAlarm(Date.now() + this.graceMs + 5_000).catch(() => {});
        }
    }

    async alarm() {
        // Fires only for a room left with zero connections. If still empty, the
        // game is dead — hand the admission slot back so it isn't leaked. A cold
        // instance has no in-memory roomId; recover it from storage first.
        if (this.sockets.size !== 0) return;
        if (!this.roomId) this.roomId = await this.state.storage.get(ROOM_KEY);
        await this._release();
    }

    async _release() {
        if (this.released) return;
        this.released = true;
        this.admitted = false;
        // Drop the engine so this resident DO reads as GONE, not FULL, when the
        // same code is dialled again — a join-by-code now hits the no-engine
        // ROOM_NOT_FOUND path instead of seating into the dead game's full lobby.
        this.engine = null;
        try {
            if (this.roomId) {
                await this._admissionStub().fetch(
                    `https://do/release?room=${encodeURIComponent(this.roomId)}`,
                );
            }
        } catch { /* best-effort; the slot is small and admit re-checks liveness */ }
        this.state.storage.deleteAlarm().catch(() => {});
        this.state.storage.delete(ROOM_KEY).catch(() => {});
        // Drop the resume snapshot too: a released room is GONE, so a later cold
        // instance must not rebuild it from a stale snapshot in _restore.
        this.state.storage.delete(GAME_KEY).catch(() => {});
    }
}
