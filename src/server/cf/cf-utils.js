/**
 * Shared helpers for the Cloudflare Worker + Durable Objects in server/cf/.
 * Kept in one place so the three DO modules + the router don't each re-roll the
 * same JSON/env/socket plumbing (CLAUDE.md → "dedupe aggressively").
 */

/** JSON Response with the right content-type. */
export function json(obj, status = 200) {
    return new Response(JSON.stringify(obj), {
        status,
        headers: { 'content-type': 'application/json' },
    });
}

/** Read a numeric Worker env var, falling back when unset/garbage. */
export function numEnv(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

// Seat clamp is shared with the Node server — single definition lives in the
// transport shell; re-exported here so the CF modules keep importing it locally.
export { clampSeats } from '../transport-shell.js';

// Durable Object singleton names. The Admission gate and the public Matchmaker
// are each one global instance, addressed by a fixed name from the Worker + DOs.
export const ADMISSION_NAME = 'global';
export const MATCH_NAME = 'global';

/** 426 Response unless the request is a WebSocket upgrade; null when it is. */
export function requireWebsocket(request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('expected a websocket upgrade', { status: 426 });
    }
    return null;
}

/** Best-effort send of a pre-stringified frame; a closed socket is a no-op. */
export function safeSend(ws, str) {
    try { ws.send(str); } catch { /* socket closing/closed */ }
}

/**
 * Accept a WebSocket only to deliver one terminal frame (e.g. a capacity
 * rejection), then close. Lets the Worker/DO answer a `wss://` upgrade with a
 * structured `{ t:"busy" }` the client can render, instead of an opaque HTTP
 * error the browser swallows.
 */
export function wsReject(msg) {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    safeSend(server, JSON.stringify(msg));
    server.close(1000, 'rejected');
    return new Response(null, { status: 101, webSocket: client });
}

/** A fresh crypto-quality 32-bit seed for a room's dice RNG. */
export function randomSeed() {
    return crypto.getRandomValues(new Uint32Array(1))[0] >>> 0;
}
