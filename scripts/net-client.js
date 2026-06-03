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
            room: this.opts.room,
            session: this.opts.session,
            name: this.opts.name || '',
            ...(this.opts.params || {}),
        });
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
    close() { this.ws?.close(); }
}
