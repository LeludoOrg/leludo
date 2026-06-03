/**
 * net-client.js — thin browser WebSocket client for multiplayer mode.
 *
 * Connect, send *intents* (roll / move), and hand every server broadcast to a
 * callback. It holds NO game rules — the server is authoritative; this just
 * transports intents up and renders broadcasts down. Single-player never loads
 * this module.
 */

const DEFAULT_PORT = 8890;

/** Build the ws:// URL from connection options + query overrides. */
export function resolveServerUrl(explicit) {
    if (explicit) return explicit;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.hostname}:${DEFAULT_PORT}`;
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
        const stored = localStorage.getItem('leludo-mp-server');
        if (stored) return stored;
    } catch { /* non-browser / blocked storage */ }
    return resolveServerUrl();
}

/** Stable per-device session id (reconnect key). Persisted in localStorage. */
export function getSessionId() {
    try {
        let s = localStorage.getItem('leludo-mp-session');
        if (!s) {
            s = `s-${Math.random().toString(36).slice(2)}`;
            localStorage.setItem('leludo-mp-session', s);
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
    }

    connect() {
        const base = resolveServerUrl(this.opts.url);
        const q = new URLSearchParams({
            session: this.opts.session,
            name: this.opts.name || '',
            ...(this.opts.params || {}),
        });
        if (this.opts.room) q.set('room', this.opts.room); // omitted in public matchmaking
        this.ws = new WebSocket(`${base}/?${q.toString()}`);
        this.ws.addEventListener('open', () => {
            this.connected = true;
            this.opts.onOpen?.();
        });
        this.ws.addEventListener('message', (ev) => {
            let msg;
            try { msg = JSON.parse(ev.data); } catch { return; }
            this.opts.onMessage(msg);
        });
        this.ws.addEventListener('close', (ev) => {
            this.connected = false;
            this.opts.onClose?.(ev);
        });
        return this;
    }

    send(obj) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(obj));
        }
    }

    roll() { this.send({ t: 'roll' }); }
    move(token) { this.send({ t: 'move', token }); }

    // Host-only lobby controls (the server rejects them from non-hosts).
    setSize(n) { this.send({ t: 'lobby_size', n }); }
    setSeat(seat, seatType) { this.send({ t: 'lobby_seat', seat, seatType }); }
    kick(seat) { this.send({ t: 'lobby_kick', seat }); }
    start() { this.send({ t: 'lobby_start' }); }

    close() { this.ws?.close(); }
}
