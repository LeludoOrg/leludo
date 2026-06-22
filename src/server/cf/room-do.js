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
 *   hurting latency. Resident sockets respond instantly and write no per-move
 *   rows. The duration cost of staying resident through human think-time is real
 *   but unbilled on free; revisit hibernation (with non-gating async persist
 *   and/or alarm-based bot/grace timers) only on a paid plan where GB-s bills.
 *
 * Leak guard: when the last socket closes mid-game (every client dropped at
 * once), the DO can be evicted and its in-memory grace timers lost — which would
 * leak the admission slot. A storage alarm armed on the zero-connection
 * transition force-releases the slot if nobody reconnects within the grace
 * window. (A room that empties cleanly already ends + releases synchronously via
 * the engine, so the alarm only fires for the simultaneous-drop edge.)
 */
import { RoomEngine } from '../room-engine.js';
import { clampSeats, numEnv, randomSeed, safeSend, wsReject, ADMISSION_NAME, requireWebsocket } from './cf-utils.js';
import { MSG, ERR } from '../../scripts/net/net-protocol.js';
import { SessionSockets, engineTransport, dispatchIntent, parseConnParams } from '../transport-shell.js';

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
            // harness uses, or every game would roll an identical sequence.
            seed: randomSeed(),
            transport: engineTransport(this.sockets, () => this.engine, () => this._release()),
        });
    }

    async fetch(request) {
        const notWs = requireWebsocket(request);
        if (notWs) return notWs;

        const p = parseConnParams(new URL(request.url).searchParams);
        this.roomId = p.room.toUpperCase();
        const sessionId = p.session || `anon-${crypto.randomUUID()}`;
        const { name, color, pool } = p;
        const size = clampSeats(p.sizeRaw, 2);

        // Join-by-code into a room that doesn't exist: a resident DO only holds
        // `this.engine` while its host is connected (or within the eviction-free
        // life of the room), so a missing engine on a `join=1` connect means no
        // host ever created this code (or the room was evicted on deploy). Refuse
        // instead of auto-creating a ghost room — and do it BEFORE the admission
        // round-trip so a typo'd code can't burn a slot. `create=1` (and any
        // non-join connect, e.g. a public-match redial) still falls through to
        // _ensureEngine below.
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
            let msg;
            try { msg = JSON.parse(ev.data); } catch { return; }
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
        // releases the slot once the grace window lapses with nobody back.
        if (this.sockets.size === 0 && !this.released) {
            this.state.storage.setAlarm(Date.now() + this.graceMs + 5_000).catch(() => {});
        }
    }

    async alarm() {
        // Fires only for a room left with zero connections. If still empty, the
        // game is dead — hand the admission slot back so it isn't leaked.
        if (this.sockets.size === 0) await this._release();
    }

    async _release() {
        if (this.released) return;
        this.released = true;
        this.admitted = false;
        try {
            if (this.roomId) {
                await this._admissionStub().fetch(
                    `https://do/release?room=${encodeURIComponent(this.roomId)}`,
                );
            }
        } catch { /* best-effort; the slot is small and admit re-checks liveness */ }
        this.state.storage.deleteAlarm().catch(() => {});
    }
}
