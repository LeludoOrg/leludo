/**
 * net-client.js — thin browser WebSocket client for multiplayer mode.
 *
 * Connect, send *intents* (roll / move), and hand every server broadcast to a
 * callback. It holds NO game rules — the server is authoritative; this just
 * transports intents up and renders broadcasts down. Single-player never loads
 * this module.
 */

import { MSG } from "./net-protocol.js";
import { STORAGE_KEYS } from "../platform/storage-keys.js";

const DEFAULT_PORT = 8890;

// Deployed Cloudflare Workers (server/cf/worker.js). The client dials these in
// production; each is a custom-domain route on its Worker (see wrangler.toml —
// top-level = prod `leludo-mp`, `[env.beta]` = `leludo-mp-beta`). Override at
// runtime with the `?server=` query param or localStorage `leludo-mp-server`
// (e.g. to point at a *.workers.dev URL before the custom domain is set up).
const PROD_SERVER_URL = 'wss://mp.leludo.org';
// Beta site (beta.leludo.org) → the ISOLATED beta backend. Separate Worker,
// separate Durable Objects, separate admission counters, so beta testers never
// share rooms or hit the same caps as production players.
const BETA_SERVER_URL = 'wss://mp-beta.leludo.org';
const BETA_HOST = 'beta.leludo.org';

/** Build the ws:// URL from connection options + query overrides. */
export function resolveServerUrl(explicit) {
    if (explicit) return explicit;
    const host = location.hostname;
    // Local dev / e2e: `npm run dev` runs the Node ws server (local-server.mjs)
    // on 8890 alongside the static site, so online play works out of the box.
    if (host === 'localhost' || host === '127.0.0.1') {
        return `ws://${host}:${DEFAULT_PORT}`;
    }
    // Beta channel: the beta site talks to the beta Worker, not production.
    if (host === BETA_HOST) {
        return BETA_SERVER_URL;
    }
    // Production: the Cloudflare Worker on its own subdomain.
    return PROD_SERVER_URL;
}

/**
 * Server base URL for the app's online mode. Resolution order:
 *   1. `?server=` query param (used by e2e / manual testing),
 *   2. `leludo-mp-server` in localStorage (operator override),
 *   3. the default ws://<host>:8890 (local dev) — replaced by the deployed
 *      Cloudflare Worker URL in production.
 */
export function getConfiguredServerUrl() {
    try {
        const fromQuery = new URLSearchParams(location.search).get('server');
        if (fromQuery) return fromQuery;
        const stored = localStorage.getItem(STORAGE_KEYS.MP_SERVER);
        if (stored) return stored;
    } catch { /* non-browser / blocked storage */ }
    return resolveServerUrl();
}

const USERNAME_KEY = STORAGE_KEYS.USERNAME;

/** The player's remembered online display name (empty if never set). */
export function getUsername() {
    try {
        return (localStorage.getItem(USERNAME_KEY) || '').trim();
    } catch {
        return '';
    }
}

/** Persist the player's online display name for next time. */
export function setUsername(name) {
    try {
        const trimmed = (name || '').trim();
        if (trimmed) localStorage.setItem(USERNAME_KEY, trimmed);
    } catch { /* storage blocked */ }
}

const COLOR_KEY = STORAGE_KEYS.ONLINE_COLOR;

/** The player's preferred seat colour (0..3 = the four board colours). This is
 *  a *request*: the server seats you in that colour if it's free, else the next
 *  open seat (the room is authoritative). Defaults to 0 (red). */
export function getOnlineColor() {
    try {
        const n = Number(localStorage.getItem(COLOR_KEY));
        return Number.isInteger(n) && n >= 0 && n <= 3 ? n : 0;
    } catch {
        return 0;
    }
}

/** Persist the player's preferred seat colour (0..3). */
export function setOnlineColor(n) {
    try {
        if (Number.isInteger(n) && n >= 0 && n <= 3) localStorage.setItem(COLOR_KEY, String(n));
    } catch { /* storage blocked */ }
}

/** Stable per-device session id (reconnect key). Persisted in localStorage. */
export function getSessionId() {
    try {
        let s = localStorage.getItem(STORAGE_KEYS.MP_SESSION);
        if (!s) {
            s = `s-${Math.random().toString(36).slice(2)}`;
            localStorage.setItem(STORAGE_KEYS.MP_SESSION, s);
        }
        return s;
    } catch {
        return `s-${Math.random().toString(36).slice(2)}`;
    }
}

export class NetClient {
    /**
     * @param {object} opts
     * @param {string} [opts.url]      ws server base, e.g. ws://localhost:8890
     * @param {string} opts.room
     * @param {string} opts.session
     * @param {string} [opts.name]
     * @param {object} [opts.params]   extra query params (humans, bots, seed…)
     * @param {(msg:object)=>void} opts.onMessage
     * @param {()=>void} [opts.onOpen]
     * @param {(ev:CloseEvent)=>void} [opts.onClose]
     */
    constructor(opts) {
        this.opts = opts;
        this.ws = null;
        this.connected = false;
        // Reconnect target. Public matches start without a room (the matchmaker
        // assigns one); we capture the assigned code from the 'seated' broadcast
        // so a dropped socket rejoins the SAME room instead of re-queueing.
        this._room = opts.room;
        this._params = { ...(opts.params || {}) };
        this._closedByUs = false;
        this._everOpen = false;
        this._reconnectAttempts = 0;
        // ~30s of retries to match the server's reconnect grace window.
        this._maxReconnect = opts.maxReconnect ?? 12;
        this._reconnectDelayMs = opts.reconnectDelayMs ?? 2500;
    }

    connect() {
        this._open();
        return this;
    }

    _open() {
        const base = resolveServerUrl(this.opts.url);
        const q = new URLSearchParams({
            session: this.opts.session,
            name: this.opts.name || '',
            ...this._params,
        });
        if (this._room) q.set('room', this._room); // omitted in public matchmaking
        this.ws = new WebSocket(`${base}/?${q.toString()}`);
        this.ws.addEventListener('open', () => {
            this.connected = true;
            const wasReconnecting = this._reconnectAttempts > 0;
            this._reconnectAttempts = 0;
            this._everOpen = true;
            if (wasReconnecting) this.opts.onReconnected?.();
            else this.opts.onOpen?.();
        });
        this.ws.addEventListener('message', (ev) => {
            let msg;
            try { msg = JSON.parse(ev.data); } catch { return; }
            // Pin the reconnect target to the seated room and stop re-queueing as
            // a fresh public match on a future drop.
            if (msg && msg.t === MSG.SEATED && msg.roomId) {
                this._room = msg.roomId;
                delete this._params.mode;
            }
            this.opts.onMessage(msg);
        });
        this.ws.addEventListener('close', (ev) => {
            this.connected = false;
            this.opts.onClose?.(ev);
            // Auto-reconnect only an unexpected drop of an established session.
            if (!this._closedByUs && this._everOpen) this._scheduleReconnect();
        });
    }

    _scheduleReconnect() {
        if (this._reconnectAttempts >= this._maxReconnect) {
            this.opts.onGiveUp?.();
            return;
        }
        this._reconnectAttempts++;
        this.opts.onReconnecting?.(this._reconnectAttempts, this._maxReconnect);
        setTimeout(() => { if (!this._closedByUs) this._open(); }, this._reconnectDelayMs);
    }

    send(obj) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(obj));
        }
    }

    roll() { this.send({ t: MSG.ROLL }); }
    move(token) { this.send({ t: MSG.MOVE, token }); }

    // Host-only lobby controls (the server rejects them from non-hosts).
    setSize(n) { this.send({ t: MSG.LOBBY_SIZE, n }); }
    setSeat(seat, seatType) { this.send({ t: MSG.LOBBY_SEAT, seat, seatType }); }
    kick(seat) { this.send({ t: MSG.LOBBY_KICK, seat }); }
    start() { this.send({ t: MSG.LOBBY_START }); }

    close() { this._closedByUs = true; this.ws?.close(); }
}
