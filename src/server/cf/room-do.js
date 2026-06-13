/**
 * LudoRoomDO — one Durable Object instance per game, the authoritative state.
 *
 * Thin transport shell over the runtime-agnostic RoomEngine (server/room-engine.js).
 * It is the CF twin of the per-room block in server/local-server.mjs: same
 * engine, same `transport` contract ({broadcast, send, release}), same intent
 * switch. All rules live in scripts/* — this only moves bytes and owns sockets.
 *
 * Memory model — HIBERNATED.
 *   Sockets are accepted with the WebSocket Hibernation API
 *   (`state.acceptWebSocket`), so while a game idles between moves the runtime
 *   evicts the instance from memory and stops billing duration (GB-s) — the
 *   dominant cost of a long Ludo game, most of whose wall-clock is humans
 *   thinking. The trade-off is that in-memory state does NOT survive eviction,
 *   so the engine is serialised to storage on every state-changing broadcast
 *   (`persist` hook) and reconstructed in the constructor on the next wake.
 *
 *   Keepalive pings ({"t":"ping"}) are answered by the runtime via
 *   `setWebSocketAutoResponse` WITHOUT waking the DO, so the heartbeat that
 *   keeps the socket warm (net-client.js) costs zero duration.
 *
 *   Pending setTimeout timers (bot pacing, reconnect grace) suppress hibernation
 *   while armed, so they fire normally during their bounded windows; routine
 *   hibernation only happens with none pending (a human's turn). `_resumeTimers`
 *   in the engine re-arms them from persisted deadlines after a non-hibernation
 *   eviction (deploy/crash) so a bot turn or grace forfeit can't be stranded.
 *
 * Leak guard: when the last socket closes mid-game (every client dropped at
 * once), a storage alarm armed on the zero-connection transition force-releases
 * the admission slot if nobody reconnects within the grace window. Alarms wake a
 * hibernated DO, so the guard fires even while evicted. (A room that empties
 * cleanly already ends + releases synchronously via the engine.)
 */
import { RoomEngine, PHASES } from '../room-engine.js';
import { clampSeats, numEnv, randomSeed, safeSend, wsReject, ADMISSION_NAME, requireWebsocket } from './cf-utils.js';
import { MSG } from '../../scripts/net/net-protocol.js';
import { SessionSockets, engineTransport, dispatchIntent, parseConnParams } from '../transport-shell.js';

// The keepalive frame net-client.js sends, byte-for-byte. The runtime auto-
// answers an exact match without waking the DO; the client ignores the reply.
const PING_REQUEST = JSON.stringify({ t: MSG.PING });
const PONG_RESPONSE = JSON.stringify({ t: 'pong' });

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

        // Reconstruct after a (possibly hibernated) eviction before serving any
        // request: rehydrate the engine from storage, re-adopt the surviving
        // sockets, and re-arm the in-memory timers. blockConcurrencyWhile holds
        // incoming events until this finishes.
        this.state.blockConcurrencyWhile(async () => {
            try {
                this.state.setWebSocketAutoResponse(
                    new WebSocketRequestResponsePair(PING_REQUEST, PONG_RESPONSE),
                );
            } catch { /* older runtime: pings fall through to the PING no-op instead */ }

            const snap = await this.state.storage.get('snapshot');
            // A finished game's snapshot is kept only until _release deletes it;
            // never rehydrate one (a reused room code would resurrect a dead game).
            if (snap && snap.phase !== PHASES.ENDED) this._rebuild(snap);
            this._rebuildSockets();
            if (this.engine) this.engine._resumeTimers();
        });
    }

    _admissionStub() {
        return this.env.ADMISSION.get(this.env.ADMISSION.idFromName(ADMISSION_NAME));
    }

    /** Shared engine wiring — the transport + the persistence hook, both bound to
     *  this instance. `extra` carries the per-construction bits (size/seed). */
    _engineOpts(extra) {
        return {
            roomId: this.roomId,
            graceMs: this.graceMs,
            transport: engineTransport(this.sockets, () => this.engine, () => this._release()),
            persist: (engine) => this._persist(engine),
            ...extra,
        };
    }

    /** Persist the full engine state. Fire-and-forget: CF's output gate holds the
     *  outbound frames the engine sends right after this call until the write
     *  lands, so a client never observes a state we haven't stored. */
    _persist(engine) {
        this.state.storage.put('snapshot', engine.serialize()).catch(() => {});
    }

    _ensureEngine(cfg) {
        if (this.engine) return;
        this.engine = new RoomEngine(this._engineOpts({
            size: cfg.size,
            botNamePool: cfg.pool,
            // Fresh per-room dice stream — prod must NOT be the fixed seed the dev
            // harness uses, or every game would roll an identical sequence.
            seed: randomSeed(),
        }));
    }

    /** Rebuild a live engine from a storage snapshot after eviction. */
    _rebuild(snap) {
        this.roomId = snap.roomId;
        this.admitted = true;     // the slot was consumed before we were evicted
        this.released = false;
        this.engine = new RoomEngine(this._engineOpts({ seed: 1 })); // seed overridden by restore
        this.engine.restore(snap);
    }

    /** Re-adopt the sockets that outlived the eviction, keyed by the sessionId we
     *  stashed on each as a hibernation-surviving attachment. */
    _rebuildSockets() {
        for (const ws of this.state.getWebSockets()) {
            const att = ws.deserializeAttachment();
            if (att && att.sessionId) this.sockets.add(att.sessionId, ws);
        }
    }

    async fetch(request) {
        const notWs = requireWebsocket(request);
        if (notWs) return notWs;

        const p = parseConnParams(new URL(request.url).searchParams);
        this.roomId = p.room.toUpperCase();
        const sessionId = p.session || `anon-${crypto.randomUUID()}`;
        const { name, color, pool } = p;
        const size = clampSeats(p.sizeRaw, 2);

        // First connection to this room consumes an admission slot; later joiners
        // (and reconnects into a rehydrated room, where `admitted` was restored)
        // ride the already-open room without the round-trip.
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
        // Hibernatable accept — the runtime may evict this DO between messages.
        this.state.acceptWebSocket(server);
        // sessionId must survive that eviction: stash it on the socket so the
        // message/close handlers can recover it after a cold reconstruction.
        server.serializeAttachment({ sessionId });
        // A new connection cancels any pending zero-connection cleanup.
        this.state.storage.deleteAlarm().catch(() => {});

        this.sockets.add(sessionId, server);

        const joined = this.engine.handleJoin(sessionId, name, color);
        if (!joined.ok) safeSend(server, JSON.stringify({ t: MSG.ERROR, error: joined.error }));

        return new Response(null, { status: 101, webSocket: client });
    }

    // ---- Hibernation API handlers (replace addEventListener) ----------------

    async webSocketMessage(ws, message) {
        let msg;
        try {
            msg = JSON.parse(typeof message === 'string' ? message : new TextDecoder().decode(message));
        } catch { return; }
        const att = ws.deserializeAttachment();
        const sessionId = att && att.sessionId;
        if (sessionId && this.engine) dispatchIntent(this.engine, sessionId, msg);
    }

    async webSocketClose(ws) {
        this._onGone(ws);
    }

    async webSocketError(ws) {
        this._onGone(ws);
    }

    _onGone(ws) {
        const att = ws.deserializeAttachment();
        const sessionId = att && att.sessionId;
        if (sessionId && this.sockets.remove(sessionId, ws)) this.engine?.handleDisconnect(sessionId);
        // Last socket gone from a live game → arm the leak-guard alarm. If the
        // room hasn't already ended+released, the alarm releases the slot once
        // the grace window lapses with nobody back.
        if (this.engine && this.sockets.size === 0 && !this.released) {
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
        // Drop the snapshot so a future reuse of this room code starts clean
        // instead of rehydrating the finished game.
        this.state.storage.delete('snapshot').catch(() => {});
    }
}
