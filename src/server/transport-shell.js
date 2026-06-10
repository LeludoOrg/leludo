/**
 * Transport-shell helpers shared by BOTH server runtimes — the Node `ws` server
 * (local-server.mjs) and the Cloudflare Durable Object (cf/room-do.js). All game
 * rules live in room-engine.js + scripts/*; this owns only the per-room socket
 * bookkeeping and intent routing the two transports used to copy-paste verbatim.
 *
 * Plain ESM, no Node- or Workers-specific globals, so it loads in both runtimes.
 */
import { MSG } from '../scripts/net/net-protocol.js';

/** Clamp a requested seat count to the legal 0..4 ring. */
export function clampSeats(raw, fallback) {
    const n = Number(raw);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(0, Math.min(4, Math.floor(n)));
}

/**
 * Per-room socket registry: sessionId -> Set<socket>. The runtime's send
 * primitive is injected — Node passes a `safeSend` that JSON-stringifies, the DO
 * passes one that stringifies + swallows closed-socket errors — so the registry
 * itself always deals in plain message objects and stays runtime-agnostic.
 */
export class SessionSockets {
    constructor(send) {
        this._send = send;
        this._bySession = new Map();
    }

    get size() { return this._bySession.size; }

    has(sid) { return this._bySession.has(sid); }

    add(sid, ws) {
        let set = this._bySession.get(sid);
        if (!set) { set = new Set(); this._bySession.set(sid, set); }
        set.add(ws);
    }

    /** Remove one socket; returns true if that session now has no sockets left. */
    remove(sid, ws) {
        const set = this._bySession.get(sid);
        if (!set) return false;
        set.delete(ws);
        if (set.size === 0) { this._bySession.delete(sid); return true; }
        return false;
    }

    sendTo(sid, msg) {
        const set = this._bySession.get(sid);
        if (set) for (const ws of set) this._send(ws, msg);
    }

    broadcast(msg) {
        for (const set of this._bySession.values()) for (const ws of set) this._send(ws, msg);
    }
}

/**
 * Build the {broadcast, send, release} transport the RoomEngine expects, backed
 * by a SessionSockets registry. `getEngine` is a thunk because the engine is
 * created after the transport in local-server and lives on `this` in the DO.
 */
export function engineTransport(sockets, getEngine, onRelease) {
    return {
        broadcast: (msg) => sockets.broadcast(msg),
        send: (seat, msg) => {
            const sid = getEngine()?.seats[seat]?.sessionId;
            if (sid) sockets.sendTo(sid, msg);
        },
        release: () => onRelease(),
    };
}

/** Route one client intent frame to the engine. Shared by both transports. */
export function dispatchIntent(engine, sessionId, msg) {
    switch (msg.t) {
        case MSG.ROLL: engine.handleRoll(sessionId); break;
        case MSG.MOVE: engine.handleMove(sessionId, msg.token); break;
        case MSG.JOIN: engine.handleJoin(sessionId, msg.name, msg.color); break;
        // host-only lobby controls (the engine enforces NOT_HOST / NOT_IN_LOBBY)
        case MSG.LOBBY_SIZE: engine.handleSetSize(sessionId, msg.n); break;
        case MSG.LOBBY_SEAT: engine.handleSetSeat(sessionId, msg.seat, msg.seatType); break;
        case MSG.LOBBY_KICK: engine.handleKick(sessionId, msg.seat); break;
        case MSG.LOBBY_START: engine.handleStart(sessionId); break;
        default: break;
    }
}

/**
 * Parse the connection query params common to both runtimes. Returns raw fields;
 * the caller applies the runtime-specific transforms that legitimately differ
 * (sessionId fallback, room-id casing, clampSeats on `sizeRaw`).
 */
export function parseConnParams(q) {
    const colorRaw = q.get('color');
    return {
        room: q.get('room') || 'default',
        session: q.get('session'),
        name: q.get('name') || '',
        color: colorRaw == null || colorRaw === '' ? null : Number(colorRaw),
        pool: q.get('pool') || undefined,
        mode: q.get('mode'),
        sizeRaw: q.get('size') ?? q.get('humans'),
    };
}
