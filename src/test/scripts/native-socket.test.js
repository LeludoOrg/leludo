import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NativeWebSocket, nativeSocketAvailable } from '../../scripts/net/native-socket.js';

/**
 * NativeWebSocket — the WebSocket-shaped shim over the native OkHttp socket
 * plugin. It must look enough like a WebSocket for net-client to drive it
 * unchanged: standard readyState, addEventListener('open'|'message'|'close'),
 * send/close — AND it must ignore events from a superseded socket id (a
 * reconnect racing an old close), the native twin of net-client's own guard.
 * It dials only AFTER its listeners are registered, so a fast native open/message
 * is never lost — hence the `flush()` await before assertions that need connect().
 */
function fakePlugin() {
    const listeners = {};
    return {
        connect: vi.fn(() => Promise.resolve()),
        send: vi.fn(() => Promise.resolve()),
        close: vi.fn(() => Promise.resolve()),
        addListener: vi.fn((type, cb) => {
            (listeners[type] ||= []).push(cb);
            return Promise.resolve({ remove: vi.fn() });
        }),
        _fire(type, ev) { (listeners[type] || []).forEach(cb => cb(ev)); },
    };
}

// Let the listener-registration promises and the chained connect() settle.
const flush = async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); };

describe('NativeWebSocket shim', () => {
    let plugin;
    beforeEach(() => {
        plugin = fakePlugin();
        window.Capacitor = { Plugins: { LeludoSocket: plugin } };
    });
    afterEach(() => { delete window.Capacitor; });

    const idOf = () => plugin.connect.mock.calls[0][0].id;

    it('nativeSocketAvailable reflects whether the plugin is present', () => {
        expect(nativeSocketAvailable()).toBe(true);
        delete window.Capacitor;
        expect(nativeSocketAvailable()).toBe(false);
    });

    it('registers listeners, then dials; starts CONNECTING', async () => {
        const ws = new NativeWebSocket('wss://x/y');
        expect(ws.readyState).toBe(0);                       // CONNECTING
        expect(plugin.connect).not.toHaveBeenCalled();       // not until listeners are up
        await flush();
        expect(plugin.connect).toHaveBeenCalledWith({ url: 'wss://x/y', id: idOf() });
    });

    it('open → OPEN + fires open; message delivers {data}', async () => {
        const ws = new NativeWebSocket('wss://x/y');
        const onOpen = vi.fn(), onMsg = vi.fn();
        ws.addEventListener('open', onOpen);
        ws.addEventListener('message', onMsg);
        await flush();

        plugin._fire('open', { id: idOf() });
        expect(ws.readyState).toBe(1);                       // OPEN
        expect(onOpen).toHaveBeenCalledTimes(1);

        plugin._fire('message', { id: idOf(), data: '{"t":"state"}' });
        expect(onMsg).toHaveBeenCalledWith({ data: '{"t":"state"}' });
    });

    it('ignores events tagged with a different (superseded) socket id', async () => {
        const ws = new NativeWebSocket('wss://x/y');
        const onMsg = vi.fn(), onClose = vi.fn();
        ws.addEventListener('message', onMsg);
        ws.addEventListener('close', onClose);
        await flush();
        plugin._fire('open', { id: idOf() });

        plugin._fire('message', { id: 'ns-999', data: 'stale' });
        plugin._fire('close', { id: 'ns-999', code: 1006 });
        expect(onMsg).not.toHaveBeenCalled();
        expect(onClose).not.toHaveBeenCalled();
        expect(ws.readyState).toBe(1);                       // still OPEN
    });

    it('only sends while OPEN', async () => {
        const ws = new NativeWebSocket('wss://x/y');
        await flush();
        ws.send('early');                                    // before open — dropped
        expect(plugin.send).not.toHaveBeenCalled();
        plugin._fire('open', { id: idOf() });
        ws.send('{"t":"roll"}');
        expect(plugin.send).toHaveBeenCalledWith({ id: idOf(), data: '{"t":"roll"}' });
    });

    it('close → CLOSED, idempotent, and only the first close event counts', async () => {
        const ws = new NativeWebSocket('wss://x/y');
        const onClose = vi.fn();
        ws.addEventListener('close', onClose);
        await flush();
        plugin._fire('open', { id: idOf() });

        plugin._fire('close', { id: idOf(), code: 1006 });
        plugin._fire('close', { id: idOf(), code: 1006 });   // duplicate
        expect(ws.readyState).toBe(3);                       // CLOSED
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('close() asks the plugin to close and stops CONNECTING/OPEN', async () => {
        const ws = new NativeWebSocket('wss://x/y');
        await flush();
        plugin._fire('open', { id: idOf() });
        ws.close();
        expect(ws.readyState).toBe(2);                       // CLOSING
        expect(plugin.close).toHaveBeenCalledWith({ id: idOf() });
    });

    it('close() before the dial settles cancels connect', async () => {
        const ws = new NativeWebSocket('wss://x/y');
        ws.close();                                          // bail before listeners register
        await flush();
        expect(plugin.connect).not.toHaveBeenCalled();
    });

    it('a rejected dial surfaces as error + unexpected close', async () => {
        plugin.connect = vi.fn(() => Promise.reject(new Error('no route')));
        const ws = new NativeWebSocket('wss://x/y');
        const onErr = vi.fn(), onClose = vi.fn();
        ws.addEventListener('error', onErr);
        ws.addEventListener('close', onClose);
        await flush();
        expect(onErr).toHaveBeenCalled();
        expect(onClose).toHaveBeenCalledWith({ code: 1006, reason: undefined });
        expect(ws.readyState).toBe(3);                       // CLOSED
    });
});
