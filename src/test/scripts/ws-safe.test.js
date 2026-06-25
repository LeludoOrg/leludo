import { describe, it, expect, vi } from 'vitest';
import { safeParse, safeClose } from '../../scripts/net/ws-safe.js';

// safeParse / safeClose centralise the parse-or-drop and close-without-throwing
// idioms the client + both transports repeated. The contract callers depend on:
// safeParse never throws (returns null on garbage), safeClose never throws and
// is null-safe.
describe('safeParse', () => {
    it('parses valid JSON frames', () => {
        expect(safeParse('{"t":"roll"}')).toEqual({ t: 'roll' });
    });

    it('returns null on malformed input instead of throwing', () => {
        expect(safeParse('not json')).toBe(null);
        expect(safeParse(undefined)).toBe(null);
    });
});

describe('safeClose', () => {
    it('forwards code + reason to ws.close', () => {
        const ws = { close: vi.fn() };
        safeClose(ws, 1000, 'matched');
        expect(ws.close).toHaveBeenCalledWith(1000, 'matched');
    });

    it('swallows a throwing close()', () => {
        const ws = { close: () => { throw new Error('already gone'); } };
        expect(() => safeClose(ws)).not.toThrow();
    });

    it('is a no-op for a null/undefined socket', () => {
        expect(() => safeClose(null)).not.toThrow();
        expect(() => safeClose(undefined)).not.toThrow();
    });
});
