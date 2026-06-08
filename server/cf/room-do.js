/**
 * LudoRoomDO — one Durable Object instance per game, the authoritative state.
 *
 * Thin transport shell over the runtime-agnostic RoomEngine (server/room-engine.js).
 * It is the CF twin of the per-room block in server/local-server.mjs: same
 * engine, same `transport` contract ({broadcast, send, release}), same intent
 * switch. All rules live in scripts/* — this only moves bytes and owns sockets.
 *
 * Memory model — pinned, NOT hibernated (deliberate, see plan).
 *   The engine keeps live state (board, RNG stream, bot/grace setTimeout timers)
 *   in this instance's memory. We accept WebSockets with `server.accept()`
 *   (standard, not the Hibernation API) so the runtime keeps the DO resident
 *   while ≥1 client is connected — exactly like the Node process the engine was
 *   written for, so its plain setTimeout-based bot pacing and reconnect grace
 *   work without change. The trade-off is duration (GB-s) while a game idles
 *   between moves; on the FREE plan an over-limit throttles, it never bills, so
 *   the "structurally unspendable" guarantee holds. WebSocket Hibernation (zero
 *   idle duration) is a documented follow-up — it requires persisting+rehydrating
 *   the engine (incl. a resumable RNG) on every eviction.
 *
 * Leak guard: when the last socket closes mid-game (every client dropped at
 * once), the DO can be evicted and its in-memory grace timers lost — which would
 * leak the admission slot. A storage alarm armed on the zero-connection
 * transition force-releases the slot if nobody reconnects within the grace
 * window. (A room that empties cleanly already ends + releases synchronously via
 * the engine, so the alarm only fires for the simultaneous-drop edge.)
 */
import { RoomEngine } from '../room-engine.js';
import { clampSeats, numEnv, randomSeed, safeSend, wsReject } from './cf-utils.js';

const ADMISSION_NAME = 'global';

export class LudoRoomDO {
    constructor(state, env) {
        this.state = state;
        this.env = env;
        this.engine = null;
        this.roomId = null;
        this.admitted = false;   // this room has consumed an admission slot
        this.released = false;   // ...and given it back (idempotent)
        this.sockets = new Map();    // sessionId -> Set<WebSocket>
        this.graceMs = numEnv(env.RECONNECT_GRACE_MS, 60_000);
    }

    _admissionStub() {
        return this.env.ADMISSION.get(this.env.ADMISSION.idFromName(ADMISSION_NAME));
    }

    /** The {broadcast, send, release} the engine expects, backed by live sockets. */
    _transport() {
        const sockets = this.sockets;
        return {
            broadcast: (msg) => {
                const s = JSON.stringify(msg);
                for (const set of sockets.values()) for (const ws of set) safeSend(ws, s);
            },
            send: (seat, msg) => {
                const sid = this.engine?.seats[seat]?.sessionId;
                if (!sid) return;
                const set = sockets.get(sid);
                if (!set) return;
                const s = JSON.stringify(msg);
                for (const ws of set) safeSend(ws, s);
            },
            release: () => { this._release(); },
        };
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
            transport: this._transport(),
        });
    }

    async fetch(request) {
        const url = new URL(request.url);
        if (request.headers.get('Upgrade') !== 'websocket') {
            return new Response('expected a websocket upgrade', { status: 426 });
        }

        const q = url.searchParams;
        this.roomId = (q.get('room') || 'default').toUpperCase();
        const sessionId = q.get('session') || `anon-${crypto.randomUUID()}`;
        const name = q.get('name') || '';
        const colorRaw = q.get('color');
        const color = colorRaw == null || colorRaw === '' ? null : Number(colorRaw);
        const pool = q.get('pool') || undefined;
        const size = clampSeats(q.get('size') ?? q.get('humans'), 2);

        // First connection to this room consumes an admission slot; later joiners
        // ride the already-open room (Admission treats a re-admit of a live room
        // as a free no-op, but we skip the round-trip entirely once admitted).
        if (!this.admitted) {
            const res = await this._admissionStub().fetch(
                `https://do/admit?room=${encodeURIComponent(this.roomId)}`,
            );
            const verdict = await res.json();
            if (!verdict.ok) return wsReject({ t: 'busy', reason: verdict.reason });
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

        if (!this.sockets.has(sessionId)) this.sockets.set(sessionId, new Set());
        this.sockets.get(sessionId).add(server);

        const joined = this.engine.handleJoin(sessionId, name, color);
        if (!joined.ok) safeSend(server, JSON.stringify({ t: 'error', error: joined.error }));

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
        const e = this.engine;
        if (!e) return;
        switch (msg.t) {
            case 'roll': e.handleRoll(sessionId); break;
            case 'move': e.handleMove(sessionId, msg.token); break;
            case 'join': e.handleJoin(sessionId, msg.name, msg.color); break;
            // host-only lobby controls (the engine enforces NOT_HOST / NOT_IN_LOBBY)
            case 'lobby_size': e.handleSetSize(sessionId, msg.n); break;
            case 'lobby_seat': e.handleSetSeat(sessionId, msg.seat, msg.seatType); break;
            case 'lobby_kick': e.handleKick(sessionId, msg.seat); break;
            case 'lobby_start': e.handleStart(sessionId); break;
            default: break;
        }
    }

    _onClose(sessionId, ws) {
        const set = this.sockets.get(sessionId);
        if (set) {
            set.delete(ws);
            if (set.size === 0) {
                this.sockets.delete(sessionId);
                this.engine?.handleDisconnect(sessionId);
            }
        }
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
            await this._admissionStub().fetch(
                `https://do/release?room=${encodeURIComponent(this.roomId)}`,
            );
        } catch { /* best-effort; the slot is small and admit re-checks liveness */ }
        this.state.storage.deleteAlarm().catch(() => {});
    }
}
