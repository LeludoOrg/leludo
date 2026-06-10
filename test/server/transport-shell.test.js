import { describe, it, expect, vi } from 'vitest';
import {
    SessionSockets,
    engineTransport,
    dispatchIntent,
    parseConnParams,
    clampSeats,
} from '../../server/transport-shell.js';
import { MSG } from '../../scripts/net-protocol.js';

describe('clampSeats', () => {
    it('clamps to 0..4 and falls back on garbage', () => {
        expect(clampSeats('3', 2)).toBe(3);
        expect(clampSeats('9', 2)).toBe(4);
        expect(clampSeats('-1', 2)).toBe(0);
        expect(clampSeats('abc', 2)).toBe(2);   // NaN → fallback
        expect(clampSeats(undefined, 2)).toBe(2); // NaN → fallback
        expect(clampSeats(null, 2)).toBe(0);     // Number(null) === 0, finite
    });
});

describe('SessionSockets', () => {
    it('groups sockets by session and broadcasts via the injected send', () => {
        const sent = [];
        const ss = new SessionSockets((ws, msg) => sent.push([ws, msg]));
        ss.add('s1', 'wsA');
        ss.add('s1', 'wsB');
        ss.add('s2', 'wsC');
        expect(ss.size).toBe(2);

        ss.broadcast({ t: 'x' });
        expect(sent.map(([ws]) => ws).sort()).toEqual(['wsA', 'wsB', 'wsC']);
    });

    it('sendTo targets only one session', () => {
        const sent = [];
        const ss = new SessionSockets((ws, msg) => sent.push(ws));
        ss.add('s1', 'wsA');
        ss.add('s2', 'wsC');
        ss.sendTo('s2', { t: 'x' });
        expect(sent).toEqual(['wsC']);
    });

    it('remove returns true only when the session empties', () => {
        const ss = new SessionSockets(() => {});
        ss.add('s1', 'wsA');
        ss.add('s1', 'wsB');
        expect(ss.remove('s1', 'wsA')).toBe(false); // wsB remains
        expect(ss.has('s1')).toBe(true);
        expect(ss.remove('s1', 'wsB')).toBe(true);  // now empty
        expect(ss.has('s1')).toBe(false);
        expect(ss.size).toBe(0);
    });
});

describe('engineTransport', () => {
    it('routes seat sends through the engine seat→session lookup', () => {
        const sent = [];
        const ss = new SessionSockets((ws, msg) => sent.push([ws, msg]));
        ss.add('host', 'wsHost');
        const engine = { seats: [{ sessionId: 'host' }, { sessionId: null }] };
        const transport = engineTransport(ss, () => engine, () => {});

        transport.send(0, { t: 'hi' });
        expect(sent).toEqual([['wsHost', { t: 'hi' }]]);

        sent.length = 0;
        transport.send(1, { t: 'hi' }); // seat 1 has no session → no send
        expect(sent).toEqual([]);
    });

    it('release fires the provided callback', () => {
        const onRelease = vi.fn();
        const t = engineTransport(new SessionSockets(() => {}), () => null, onRelease);
        t.release();
        expect(onRelease).toHaveBeenCalledOnce();
    });
});

describe('dispatchIntent', () => {
    it('maps each frame type to the matching engine method', () => {
        const engine = {
            handleRoll: vi.fn(), handleMove: vi.fn(), handleJoin: vi.fn(),
            handleSetSize: vi.fn(), handleSetSeat: vi.fn(), handleKick: vi.fn(), handleStart: vi.fn(),
        };
        dispatchIntent(engine, 'sid', { t: MSG.ROLL });
        dispatchIntent(engine, 'sid', { t: MSG.MOVE, token: 2 });
        dispatchIntent(engine, 'sid', { t: MSG.LOBBY_KICK, seat: 1 });
        dispatchIntent(engine, 'sid', { t: 'unknown' }); // no-op

        expect(engine.handleRoll).toHaveBeenCalledWith('sid');
        expect(engine.handleMove).toHaveBeenCalledWith('sid', 2);
        expect(engine.handleKick).toHaveBeenCalledWith('sid', 1);
        expect(engine.handleStart).not.toHaveBeenCalled();
    });
});

describe('parseConnParams', () => {
    it('reads the common fields, leaving runtime transforms to the caller', () => {
        const q = new URLSearchParams('room=ABCD&session=s1&name=Vee&color=2&pool=hindi&mode=public&humans=3');
        expect(parseConnParams(q)).toEqual({
            room: 'ABCD', session: 's1', name: 'Vee', color: 2,
            pool: 'hindi', mode: 'public', sizeRaw: '3',
        });
    });

    it('defaults room and null color when absent', () => {
        const p = parseConnParams(new URLSearchParams(''));
        expect(p.room).toBe('default');
        expect(p.color).toBe(null);
        expect(p.sizeRaw).toBe(null);
    });
});
