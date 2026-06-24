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
import { isCapacitorNative } from "../platform/platform.js";
import { NativeWebSocket, nativeSocketAvailable } from "./native-socket.js";

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
    // The shipped Capacitor APK serves from https://localhost, so location.hostname
    // lies — it looks like local dev. The native runtime flag is the real signal:
    // a native build always dials production (there is no dev ws server on a phone).
    if (isCapacitorNative()) return PROD_SERVER_URL;
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

/** Fresh unguessable session id. Uses crypto when available, falls back to Math.random. */
function newSessionId() {
    try {
        return `s-${crypto.randomUUID()}`;
    } catch {
        return `s-${Math.random().toString(36).slice(2)}`;
    }
}

/** Stable per-device session id (reconnect key). Persisted in localStorage. */
export function getSessionId() {
    try {
        let s = localStorage.getItem(STORAGE_KEYS.MP_SESSION);
        if (!s) {
            s = newSessionId();
            localStorage.setItem(STORAGE_KEYS.MP_SESSION, s);
        }
        return s;
    } catch {
        return newSessionId();
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
        this._suspended = false;   // dropped via suspend(), awaiting resume()
        this._everOpen = false;
        this._reconnectAttempts = 0;
        // ~30s of retries to match the server's reconnect grace window.
        this._maxReconnect = opts.maxReconnect ?? 12;
        this._reconnectDelayMs = opts.reconnectDelayMs ?? 2500;
        // Keepalive cadence. Comfortably under the ~60s idle-reap floor so two
        // pings cover every window; see MSG.PING.
        this._pingMs = opts.pingMs ?? 25_000;
        this._pingTimer = null;
        // Pending backoff redial (see _scheduleReconnect). Stored so reconnectNow()
        // can cancel the wait and dial immediately when the app returns to the
        // foreground, and so close()/suspend() can cancel a queued attempt.
        this._reconnectTimer = null;
    }

    connect() {
        this._open();
        return this;
    }

    /** Pick the transport: on a Capacitor Android build the native OkHttp socket
     *  (kept warm off the WebView's throttle-prone JS thread) when the plugin is
     *  present, else the WebView's own WebSocket. Both expose the same surface,
     *  so the rest of net-client is transport-agnostic. */
    _makeSocket(url) {
        if (isCapacitorNative() && nativeSocketAvailable()) return new NativeWebSocket(url);
        return new WebSocket(url);
    }

    /** The ws URL for this session/room, with the current query params. Shared by
     *  _open() and the throwaway forfeit socket in leaveNow() so the connection
     *  string stays defined in exactly one place. */
    _url() {
        const base = resolveServerUrl(this.opts.url);
        const q = new URLSearchParams({
            session: this.opts.session,
            name: this.opts.name || '',
            ...this._params,
        });
        if (this._room) q.set('room', this._room); // omitted in public matchmaking
        return `${base}/?${q.toString()}`;
    }

    _open() {
        const sock = this._makeSocket(this._url());
        this.ws = sock;
        // A reconnectNow() (app resume) can replace this.ws while an old socket is
        // still mid-close; ignore events from any socket we've already superseded
        // so a zombie's late `close` can't fire a second redial.
        const isCurrent = () => this.ws === sock;
        sock.addEventListener('open', () => {
            if (!isCurrent()) return;
            this.connected = true;
            const wasReconnecting = this._reconnectAttempts > 0;
            this._reconnectAttempts = 0;
            this._everOpen = true;
            if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
            this._startPing();
            if (wasReconnecting) this.opts.onReconnected?.();
            else this.opts.onOpen?.();
        });
        sock.addEventListener('message', (ev) => {
            if (!isCurrent()) return;
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
        sock.addEventListener('close', (ev) => {
            if (!isCurrent()) return; // superseded by a newer socket — its lifecycle owns reconnect
            this.connected = false;
            this._stopPing();
            this.opts.onClose?.(ev);
            // Auto-reconnect only an unexpected drop of an established session.
            if (!this._closedByUs && this._everOpen) this._scheduleReconnect();
        });
    }

    // Heartbeat: keep the idle socket warm so intermediaries don't reap it (see
    // MSG.PING). Idle-reset, not a fixed interval — every real outbound frame
    // (roll, move, lobby edit) reschedules the ping via send(), so we only emit a
    // PING after a full pingMs of outbound silence. During a player's own turn the
    // ROLL/MOVE traffic already keeps the connection warm at the DO, so the
    // redundant ping is skipped. Resetting only on OUTBOUND traffic preserves the
    // guarantee that the DO receives a client frame at least every pingMs.
    _startPing() { this._armPing(); }

    _armPing() {
        this._stopPing();
        // send() no-ops unless the socket is OPEN, so a stray tick is safe; the
        // PING it emits re-arms the next tick through send() below.
        this._pingTimer = setTimeout(() => this.send({ t: MSG.PING }), this._pingMs);
    }

    _stopPing() {
        if (this._pingTimer) { clearTimeout(this._pingTimer); this._pingTimer = null; }
    }

    _scheduleReconnect() {
        if (this._reconnectAttempts >= this._maxReconnect) {
            this.opts.onGiveUp?.();
            return;
        }
        this._reconnectAttempts++;
        this.opts.onReconnecting?.(this._reconnectAttempts, this._maxReconnect);
        this._reconnectTimer = setTimeout(() => {
            this._reconnectTimer = null;
            if (!this._closedByUs) this._open();
        }, this._reconnectDelayMs);
    }

    /**
     * Foreground regained — the app resumed or the tab became visible. A native
     * WebView FREEZES its JS while backgrounded: the keepalive PING can't fire,
     * so the socket gets reaped by the edge/NAT, and our own `close` handler +
     * 2.5s backoff don't run until we're back — by then a chunk of the server's
     * reconnect-grace window is already gone (and on Android a long freeze can
     * blow past it entirely, forfeiting the seat). Skip the wait: if we're not
     * already connected (and weren't closed on purpose), redial immediately.
     *
     * No-op when the socket is healthy (just probe it with a PING + re-arm the
     * keepalive) or when we deliberately suspended for the exit confirmation.
     */
    reconnectNow() {
        if (this._closedByUs || this._suspended || !this._everOpen) return;
        const state = this.ws?.readyState;
        if (state === WebSocket.CONNECTING) return; // a redial is already in flight
        if (state === WebSocket.OPEN) { this.send({ t: MSG.PING }); return; } // alive — probe + re-arm
        // CLOSED / CLOSING / no socket: cancel any queued backoff and dial now.
        if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
        this._reconnectAttempts = 0;
        this.opts.onReconnecting?.(0, this._maxReconnect);
        this._open();
    }

    send(obj) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(obj));
            // Any real outbound frame keeps the socket warm, so defer the next
            // keepalive — we only PING after a full idle window (see _armPing).
            this._armPing();
        }
    }

    roll() { this.send({ t: MSG.ROLL }); }
    move(token) { this.send({ t: MSG.MOVE, token }); }

    // Voluntarily drop the socket WITHOUT auto-reconnecting — the server sees a
    // plain disconnect (it starts this seat's reconnect grace and holds the game,
    // exactly as a network drop would), but unlike close() this stays resumable.
    // Backs the in-game "exit" confirmation: while the player decides, they read
    // as disconnected to everyone else; resume() reels them back in.
    suspend() {
        if (this._suspended) return;
        this._suspended = true;
        this._closedByUs = true; // suppress _scheduleReconnect on this close
        this._stopPing();
        if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
        try { this.ws?.close(); } catch { /* already gone */ }
    }

    /**
     * Player confirmed "Leave game": forfeit the seat NOW instead of waiting out
     * the reconnect grace. The exit dialog suspended our socket, so we can't send
     * over it — fire a throwaway connection whose only job is to deliver one LEAVE
     * frame on open and then close. It is deliberately NOT this.ws, so the game's
     * teardown (which closes this.ws right after) can't race or cancel it. The
     * server sees a reconnect immediately followed by an explicit leave → it frees
     * the seat at once. Best-effort: if the throwaway can't reach the server, the
     * suspended socket's grace still forfeits us, just on the old timeline.
     */
    leaveNow() {
        // Never suspended (e.g. headless exit path): the live socket is still up,
        // so just tell the server and let the impending close() tear it down.
        if (!this._suspended && this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.send({ t: MSG.LEAVE });
            return;
        }
        try {
            const sock = this._makeSocket(this._url());
            const fire = () => {
                try { sock.send(JSON.stringify({ t: MSG.LEAVE })); } catch { /* ignore */ }
                try { sock.close(); } catch { /* ignore */ }
            };
            sock.addEventListener('open', fire);
            // A failed dial just closes; the suspended socket's grace covers us.
            sock.addEventListener('error', () => { try { sock.close(); } catch { /* ignore */ } });
        } catch { /* server unreachable — grace forfeits us on the old timeline */ }
    }

    /** Reopen after suspend() — redial the SAME session/room, which the server
     *  treats as a reconnect (cancels the forfeit grace, un-dims the seat). */
    resume() {
        if (!this._suspended) return;
        this._suspended = false;
        this._closedByUs = false;
        this._reconnectAttempts = 0;
        this._open();
    }

    // Host-only lobby controls (the server rejects them from non-hosts).
    setSize(n) { this.send({ t: MSG.LOBBY_SIZE, n }); }
    setSeat(seat, seatType) { this.send({ t: MSG.LOBBY_SEAT, seat, seatType }); }
    kick(seat) { this.send({ t: MSG.LOBBY_KICK, seat }); }
    start() { this.send({ t: MSG.LOBBY_START }); }

    // Any seated player: set their own name and/or colour (open-seat move) in the
    // lobby. Sent on a name blur (`{name}`) or a colour tap (`{seat}`), not per
    // keystroke, so it stays one message per deliberate edit.
    setProfile({ name, seat } = {}) { this.send({ t: MSG.LOBBY_PROFILE, name, seat }); }

    close() {
        this._closedByUs = true;
        this._stopPing();
        if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
        this.ws?.close();
    }
}
