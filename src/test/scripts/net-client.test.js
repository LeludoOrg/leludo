import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NetClient, resolveServerUrl } from '../../scripts/net/net-client.js';

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

    it('honours an explicit override verbatim', () => {
        stubHost('leludo.org');
        expect(resolveServerUrl('wss://leludo-mp.acme.workers.dev'))
            .toBe('wss://leludo-mp.acme.workers.dev');
    });
});

/**
 * Auto-reconnect guards the multiplayer disconnect feature: a dropped socket
 * must transparently re-open with the SAME session (so the server hands the
 * seat back) and must NOT re-queue a public match as a brand-new game.
 * A fake WebSocket lets us script open / message / drop deterministically.
 */
class FakeWS {
    static OPEN = 1;
    static instances = [];
    constructor(url) {
        this.url = url;
        this.readyState = 0;
        this._l = {};
        FakeWS.instances.push(this);
    }
    addEventListener(type, fn) { (this._l[type] ||= []).push(fn); }
    send() {}
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
