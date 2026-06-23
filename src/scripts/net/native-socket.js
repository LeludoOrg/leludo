/**
 * native-socket.js — a WebSocket-shaped shim backed by the native OkHttp socket
 * (the Capacitor `LeludoSocket` plugin, Android only).
 *
 * WHY: the multiplayer connection lives in the WebView's JS. On Android the
 * System WebView throttles JS timers (and can let the page's own
 * `new WebSocket()` go quiet) while the app is backgrounded / dozing / under
 * battery-saver — the keepalive PING slips, the edge reaps the idle socket, and
 * we churn through reconnects. Running the socket on a NATIVE thread, with a
 * native ping-keepalive that fires regardless of WebView JS state, keeps the
 * connection warm; buffered frames are delivered to JS as soon as the loop
 * resumes. (This addresses CONNECTION liveness only — rendering still runs in
 * JS; the render loop is a separate concern.)
 *
 * It exposes only the slice of the WebSocket API net-client.js uses: the
 * standard numeric `readyState`, `addEventListener`/`removeEventListener` for
 * 'open' | 'message' | 'close' | 'error', `send()` and `close()`. net-client
 * keeps ALL reconnect/keepalive policy in JS — this is purely the transport.
 */

// readyState values match the WHATWG WebSocket constants so net-client's
// comparisons against the global `WebSocket.OPEN` / `WebSocket.CONNECTING`
// (which exist in the WebView regardless) line up with the shim.
const CONNECTING = 0, OPEN = 1, CLOSING = 2, CLOSED = 3;

let _seq = 0;

/** The registered native plugin proxy, or null if this build doesn't have it.
 *  `isPluginAvailable` is Capacitor's canonical "is this plugin registered on
 *  the current platform" check; `Plugins[...]`/`registerPlugin` give the proxy
 *  (the bare-`Plugins` fallback keeps the test mock and older runtimes working). */
function nativePlugin() {
    const cap = typeof window !== 'undefined' ? window.Capacitor : null;
    if (!cap) return null;
    const available = typeof cap.isPluginAvailable === 'function'
        ? cap.isPluginAvailable('LeludoSocket')
        : !!(cap.Plugins && cap.Plugins.LeludoSocket);
    if (!available) return null;
    return (cap.Plugins && cap.Plugins.LeludoSocket)
        || (typeof cap.registerPlugin === 'function' ? cap.registerPlugin('LeludoSocket') : null);
}

/** True when the native socket plugin is present (Capacitor Android build). */
export function nativeSocketAvailable() {
    return !!nativePlugin();
}

export class NativeWebSocket {
    constructor(url) {
        this._plugin = nativePlugin();
        // Per-instance id: the plugin tags every event with the id of the socket
        // it came from, so a superseded socket's late events (a reconnect racing
        // an old close) are filtered out here — mirrors net-client's own guard.
        this._id = `ns-${++_seq}`;
        this.url = url;
        this.readyState = CONNECTING;
        this._listeners = { open: [], message: [], close: [], error: [] };
        this._handles = [];
        this._closed = false;

        const ready = [];
        for (const type of ['open', 'message', 'close', 'error']) {
            // addListener resolves to a handle ({ remove() }); keep the promise so
            // close() can detach. Events for other socket ids are ignored.
            const h = this._plugin.addListener(type, (ev) => {
                if (!ev || ev.id !== this._id) return;
                this._emit(type, ev);
            });
            this._handles.push(h);
            ready.push(Promise.resolve(h));
        }

        // Dial only AFTER the event listeners are registered — otherwise a fast
        // native `open`/`message` could fire before JS is listening and be lost.
        // close() before we get here cancels the dial.
        Promise.all(ready)
            .then(() => { if (!this._closed) return this._plugin.connect({ url, id: this._id }); })
            .catch((e) => {
                // A failed dial reads as an immediate unexpected close, so
                // net-client's reconnect path takes over as for any dropped socket.
                this._emit('error', { message: String((e && e.message) || e) });
                this._emit('close', { code: 1006 });
            });
    }

    _emit(type, ev) {
        if (type === 'open') this.readyState = OPEN;
        else if (type === 'close') { if (this.readyState === CLOSED) return; this.readyState = CLOSED; }
        const detail = type === 'message'
            ? { data: ev.data }
            : { code: ev.code, reason: ev.reason };
        for (const fn of [...this._listeners[type]]) {
            try { fn(detail); } catch { /* a listener throwing must not drop the rest */ }
        }
    }

    addEventListener(type, fn) { (this._listeners[type] ||= []).push(fn); }

    removeEventListener(type, fn) {
        const a = this._listeners[type];
        if (a) { const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); }
    }

    send(data) {
        if (this.readyState !== OPEN) return;
        try { this._plugin.send({ id: this._id, data }); } catch { /* socket gone */ }
    }

    close() {
        if (this.readyState === CLOSED) return;
        this._closed = true; // cancels a dial still waiting on listener registration
        this.readyState = CLOSING;
        try { this._plugin.close({ id: this._id }); } catch { /* already gone */ }
        for (const h of this._handles) {
            Promise.resolve(h).then(x => x && x.remove && x.remove()).catch(() => {});
        }
        this._handles = [];
    }
}
