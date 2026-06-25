import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    NetClient,
    resolveServerUrl,
    getConfiguredServerUrl,
    getServerChannel,
    setServerChannel,
} from '../../scripts/net/net-client.js';

/**
 * Server-URL resolution. Regression guard: production used to derive
 * `wss://<host>:8890`, which points at a port nothing serves on leludo.org —
 * online play could never connect. Prod must resolve to the deployed Cloudflare
 * Worker; only localhost keeps the dev ws server on :8890.
 */
describe('resolveServerUrl', () => {
    const stubHost = (hostname, protocol = 'https:') =>
        vi.stubGlobal('location', { hostname, protocol });
    afterEach(() => vi.unstubAllGlobals());

    it('uses the local Node ws server on localhost / 127.0.0.1', () => {
        stubHost('localhost', 'http:');
        expect(resolveServerUrl()).toBe('ws://localhost:8890');
        stubHost('127.0.0.1', 'http:');
        expect(resolveServerUrl()).toBe('ws://127.0.0.1:8890');
    });

    it('points production at the Cloudflare Worker, NOT host:8890', () => {
        stubHost('leludo.org');
        expect(resolveServerUrl()).toBe('wss://mp.leludo.org');
    });

    // The beta site must hit the ISOLATED beta backend, not production — beta
    // testers share neither rooms nor admission caps with real players.
    it('points the beta site at the separate beta Worker', () => {
        stubHost('beta.leludo.org');
        expect(resolveServerUrl()).toBe('wss://mp-beta.leludo.org');
    });

    it('honours an explicit override verbatim', () => {
        stubHost('leludo.org');
        expect(resolveServerUrl('wss://leludo-mp.acme.workers.dev'))
            .toBe('wss://leludo-mp.acme.workers.dev');
    });

    // Regression: the shipped Capacitor APK serves from https://localhost, so
    // hostname looks like local dev and used to resolve ws://localhost:8890 — a
    // dev server that doesn't exist on a phone, so Online could never connect.
    // window.Capacitor.isNativePlatform() is the real signal: native dials prod.
    it('dials production from the Capacitor APK despite the localhost hostname', () => {
        stubHost('localhost', 'https:');
        vi.stubGlobal('window', { Capacitor: { isNativePlatform: () => true } });
        expect(resolveServerUrl()).toBe('wss://mp.leludo.org');
    });
});

/**
 * Hidden tester backend-channel override. The shipped APK always dials prod via
 * resolveServerUrl() — a promoted, byte-identical artifact has no signal for
 * "which Play track installed me", so internal-track installs can't auto-route
 * to beta. The About-dialog secret toggle instead writes the leludo-mp-server
 * key getConfiguredServerUrl() honors. Guard: flipping the channel actually
 * re-points the backend on a native build, and reverting cleanly clears it.
 */
describe('server channel override (hidden tester toggle)', () => {
    beforeEach(() => { try { localStorage.clear(); } catch { /* no storage */ } });
    afterEach(() => {
        try { localStorage.clear(); } catch { /* no storage */ }
        delete window.Capacitor;
        vi.unstubAllGlobals();
    });

    it('defaults to prod with no override', () => {
        expect(getServerChannel()).toBe('prod');
    });

    it('flips a native build onto the isolated beta backend and back', () => {
        // Native APK: hostname is https://localhost and isCapacitorNative() true,
        // so the default resolves to prod — the toggle must override that.
        vi.stubGlobal('location', { hostname: 'localhost', protocol: 'https:', search: '' });
        window.Capacitor = { isNativePlatform: () => true };

        setServerChannel('beta');
        expect(getServerChannel()).toBe('beta');
        expect(getConfiguredServerUrl()).toBe('wss://mp-beta.leludo.org'); // not prod

        setServerChannel('prod');
        expect(getServerChannel()).toBe('prod');
        expect(getConfiguredServerUrl()).toBe('wss://mp.leludo.org'); // override cleared
    });
});

/**
 * Auto-reconnect guards the multiplayer disconnect feature: a dropped socket
 * must transparently re-open with the SAME session (so the server hands the
 * seat back) and must NOT re-queue a public match as a brand-new game.
 * A fake WebSocket lets us script open / message / drop deterministically.
 */
class FakeWS {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    static instances = [];
    constructor(url) {
        this.url = url;
        this.readyState = 0;
        this._l = {};
        this.sent = [];
        FakeWS.instances.push(this);
    }
    addEventListener(type, fn) { (this._l[type] ||= []).push(fn); }
    send(data) { this.sent.push(JSON.parse(data)); }
    close() { this.readyState = 3; this._fire('close', {}); }
    _fire(type, ev) { (this._l[type] || []).forEach(fn => fn(ev)); }
    open() { this.readyState = FakeWS.OPEN; this._fire('open', {}); }
    message(obj) { this._fire('message', { data: JSON.stringify(obj) }); }
    drop() { this.readyState = 3; this._fire('close', { code: 1006 }); } // unexpected
}

const last = () => FakeWS.instances[FakeWS.instances.length - 1];

describe('NetClient auto-reconnect', () => {
    beforeEach(() => {
        FakeWS.instances = [];
        vi.stubGlobal('WebSocket', FakeWS);
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('re-opens with the same session after an unexpected drop', () => {
        const onReconnecting = vi.fn();
        const onReconnected = vi.fn();
        const net = new NetClient({
            room: 'ABCD', session: 's-1', name: 'Me',
            onMessage: () => {}, onReconnecting, onReconnected,
        });
        net.connect();
        last().open(); // established

        last().drop(); // socket lost
        expect(onReconnecting).toHaveBeenCalledTimes(1);

        vi.advanceTimersByTime(2500); // reconnect delay elapses
        expect(FakeWS.instances.length).toBe(2); // a fresh socket opened
        expect(last().url).toContain('session=s-1');
        expect(last().url).toContain('room=ABCD');

        last().open(); // reconnected
        expect(onReconnected).toHaveBeenCalledTimes(1);
    });

    it('does NOT reconnect after a deliberate close()', () => {
        const net = new NetClient({ room: 'ABCD', session: 's-1', onMessage: () => {} });
        net.connect();
        last().open();
        net.close();
        vi.advanceTimersByTime(10_000);
        expect(FakeWS.instances.length).toBe(1); // no new socket
    });

    it('rejoins the assigned room (not the public queue) after matchmaking', () => {
        const net = new NetClient({
            session: 's-1', params: { mode: 'public', size: '2' }, onMessage: () => {},
        });
        net.connect();
        const first = last();
        expect(first.url).toContain('mode=public');
        first.open();
        first.message({ t: 'seated', roomId: 'WXYZ', playerIndex: 0 }); // matched + seated
        first.drop();

        vi.advanceTimersByTime(2500);
        expect(last().url).toContain('room=WXYZ'); // back to the same room
        expect(last().url).not.toContain('mode=public'); // not a new public match
    });

    // Heartbeat regression: an idle socket (a player waiting through others'
    // turns) used to get reaped by Cloudflare's edge / NATs after ~60s with no
    // real fault, then forfeit. The client must keep it warm with periodic pings
    // while connected, and must stop pinging the moment the socket is gone.
    const pings = (ws) => ws.sent.filter(m => m.t === 'ping').length;

    it('sends keepalive pings on an interval while connected', () => {
        const net = new NetClient({
            room: 'ABCD', session: 's-1', onMessage: () => {}, pingMs: 25_000,
        });
        net.connect();
        last().open();
        expect(pings(last())).toBe(0);          // none yet
        vi.advanceTimersByTime(25_000);
        expect(pings(last())).toBe(1);          // first heartbeat
        vi.advanceTimersByTime(50_000);
        expect(pings(last())).toBe(3);          // ~one every 25s — covers a 60s reap window twice
    });

    it('skips the keepalive when a real frame was just sent (idle-reset)', () => {
        // A roll/move already keeps the socket warm at the DO, so the ping is
        // redundant — sending one resets the window instead of firing on top.
        const net = new NetClient({
            room: 'ABCD', session: 's-1', onMessage: () => {}, pingMs: 25_000,
        });
        net.connect();
        last().open();
        vi.advanceTimersByTime(20_000);         // 20s idle — not yet due
        expect(pings(last())).toBe(0);
        net.roll();                             // real outbound frame resets the window
        vi.advanceTimersByTime(20_000);         // 20s since the roll — still inside the window
        expect(pings(last())).toBe(0);          // no redundant ping piled on the roll
        vi.advanceTimersByTime(10_000);         // 30s of silence after the roll
        expect(pings(last())).toBe(1);          // ping only after a full idle window
    });

    it('stops pinging once the socket closes (no leaked interval)', () => {
        const net = new NetClient({ room: 'ABCD', session: 's-1', onMessage: () => {}, pingMs: 25_000 });
        net.connect();
        last().open();
        net.close();                            // deliberate close
        const ws = last();
        const before = pings(ws);
        vi.advanceTimersByTime(100_000);
        expect(pings(ws)).toBe(before);         // no further pings after close
    });

    it('gives up after exhausting attempts', () => {
        const onGiveUp = vi.fn();
        const net = new NetClient({
            room: 'ABCD', session: 's-1', onMessage: () => {},
            maxReconnect: 2, reconnectDelayMs: 1000, onGiveUp,
        });
        net.connect();
        last().open();
        // Each retry opens a socket that immediately drops again.
        for (let i = 0; i < 3; i++) { last().drop(); vi.advanceTimersByTime(1000); }
        expect(onGiveUp).toHaveBeenCalledTimes(1);
    });
});

/**
 * reconnectNow() — the app-resume fast path. A native WebView freezes its JS
 * (and lets its socket die) while backgrounded, so the keepalive can't fire and
 * the normal close-then-2.5s-backoff doesn't run until we're back — by which
 * point the server's reconnect grace is draining and, on a long freeze, the seat
 * gets force-forfeited (the user saw an instant "Your seat was forfeited" on
 * returning to the app). On any foreground signal we redial immediately instead
 * of waiting out the backoff.
 */
describe('NetClient reconnectNow (foreground resume)', () => {
    beforeEach(() => {
        FakeWS.instances = [];
        vi.stubGlobal('WebSocket', FakeWS);
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('redials immediately on resume, skipping the 2.5s backoff', () => {
        const net = new NetClient({ room: 'ABCD', session: 's-1', onMessage: () => {} });
        net.connect();
        last().open();
        last().drop();                       // socket lost; a 2.5s backoff is now queued
        expect(FakeWS.instances.length).toBe(1);

        net.reconnectNow();                  // app returns to foreground
        expect(FakeWS.instances.length).toBe(2);   // fresh socket NOW, no wait
        expect(last().url).toContain('session=s-1');

        // The queued backoff was cancelled — it must not open a third socket.
        vi.advanceTimersByTime(5000);
        expect(FakeWS.instances.length).toBe(2);
    });

    it('only probes (pings) a still-healthy socket — never churns a live connection', () => {
        const net = new NetClient({ room: 'ABCD', session: 's-1', onMessage: () => {} });
        net.connect();
        last().open();                       // readyState OPEN
        net.reconnectNow();
        expect(FakeWS.instances.length).toBe(1);                 // no new socket
        expect(last().sent.some(m => m.t === 'ping')).toBe(true); // probed instead
    });

    it('is a no-op while suspended for the exit confirmation', () => {
        const net = new NetClient({ room: 'ABCD', session: 's-1', onMessage: () => {} });
        net.connect();
        last().open();
        net.suspend();                       // exit-confirmation: deliberately down, resumable
        net.reconnectNow();                  // a stray resume must not reel us back in
        expect(FakeWS.instances.length).toBe(1);
    });

    it('a superseded zombie socket\'s late close does not fire a second redial', () => {
        const net = new NetClient({ room: 'ABCD', session: 's-1', onMessage: () => {} });
        net.connect();
        const zombie = last();
        zombie.open();
        zombie.readyState = FakeWS.CLOSING;  // dying, but close hasn't surfaced yet
        net.reconnectNow();                  // resume opens a fresh socket past the zombie
        expect(FakeWS.instances.length).toBe(2);

        zombie._fire('close', { code: 1006 });   // the OS finally surfaces the old close
        vi.advanceTimersByTime(5000);
        expect(FakeWS.instances.length).toBe(2);  // ignored — no duplicate connection
    });
});

/**
 * leaveNow() — the exit dialog's "Leave game" confirm. The dialog suspended the
 * socket, so an explicit forfeit can't go over it; net-client fires a throwaway
 * connection that delivers a single LEAVE and closes. The seat is freed at once
 * server-side instead of waiting out the reconnect grace.
 */
describe('NetClient leaveNow (explicit forfeit)', () => {
    beforeEach(() => {
        FakeWS.instances = [];
        vi.stubGlobal('WebSocket', FakeWS);
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('after suspend, opens a throwaway socket that sends one LEAVE then closes', () => {
        const net = new NetClient({ room: 'ABCD', session: 's-1', onMessage: () => {} });
        net.connect();
        last().open();
        net.suspend();                 // exit dialog drops the live socket
        const before = FakeWS.instances.length;

        net.leaveNow();                // player confirms "Leave game"
        expect(FakeWS.instances.length).toBe(before + 1); // a throwaway opened
        const throwaway = last();
        expect(throwaway.url).toContain('session=s-1');   // same session…
        expect(throwaway.url).toContain('room=ABCD');     // …same room

        throwaway.open();              // connects → fires LEAVE + self-closes
        expect(throwaway.sent).toEqual([{ t: 'leave' }]);
        expect(throwaway.readyState).toBe(FakeWS.CLOSED);
    });

    it('the throwaway never auto-reconnects after it closes', () => {
        const net = new NetClient({ room: 'ABCD', session: 's-1', onMessage: () => {} });
        net.connect();
        last().open();
        net.suspend();
        net.leaveNow();
        last().open();                 // delivers LEAVE + closes
        const count = FakeWS.instances.length;
        vi.advanceTimersByTime(10_000);
        expect(FakeWS.instances.length).toBe(count); // no redial off the throwaway's close
    });

    it('sends LEAVE over the live socket when it was never suspended', () => {
        const net = new NetClient({ room: 'ABCD', session: 's-1', onMessage: () => {} });
        net.connect();
        last().open();
        net.leaveNow();                // headless exit path: socket still up
        expect(last().sent).toContainEqual({ t: 'leave' });
        expect(FakeWS.instances.length).toBe(1); // no throwaway needed
    });
});

/**
 * Transport selection. On a Capacitor Android build with the native socket
 * plugin present, net-client must dial through the NATIVE socket (kept warm off
 * the WebView's throttle-prone JS thread) instead of the WebView's WebSocket —
 * the whole point of the native plugin. Anywhere else it uses the WebView socket.
 */
describe('NetClient transport selection', () => {
    afterEach(() => { vi.unstubAllGlobals(); delete window.Capacitor; });

    it('uses the native socket plugin on a Capacitor build when it is present', async () => {
        const connect = vi.fn(() => Promise.resolve());
        window.Capacitor = {
            isNativePlatform: () => true,
            Plugins: { LeludoSocket: { connect, send: () => {}, close: () => {}, addListener: () => Promise.resolve({ remove() {} }) } },
        };
        // If the factory wrongly fell through to the WebView socket, this fake
        // would record an instance instead.
        FakeWS.instances = [];
        vi.stubGlobal('WebSocket', FakeWS);

        new NetClient({ room: 'ABCD', session: 's-1', onMessage: () => {} }).connect();
        for (let i = 0; i < 4; i++) await Promise.resolve(); // shim dials after listeners register
        expect(connect).toHaveBeenCalledTimes(1);   // dialled through the native plugin
        expect(FakeWS.instances.length).toBe(0);    // NOT the WebView socket
    });

    it('uses the WebView WebSocket when not native (web build)', () => {
        window.Capacitor = { isNativePlatform: () => false };
        FakeWS.instances = [];
        vi.stubGlobal('WebSocket', FakeWS);
        new NetClient({ room: 'ABCD', session: 's-1', onMessage: () => {} }).connect();
        expect(FakeWS.instances.length).toBe(1);
    });
});
