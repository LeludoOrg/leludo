import { describe, it, expect } from 'vitest';
import { clonePositions } from '../../scripts/core/board-util.js';

// clonePositions replaced five hand-rolled copies of the token-position grid
// deep-copy. The copies disagreed on what an absent (falsy) slot becomes, so
// these assertions pin each behaviour the call sites relied on.
describe('clonePositions', () => {
    it('deep-copies each present row so the copy is independent of the source', () => {
        const src = [[0, 1, 2, 3], [-1, -1, -1, -1]];
        const out = clonePositions(src);
        out[0][0] = 99;
        expect(src[0][0]).toBe(0);       // source untouched
        expect(out[0]).not.toBe(src[0]); // rows are fresh arrays
    });

    it('preserves the original falsy slot when no `empty` is passed (bot search)', () => {
        const out = clonePositions([[0, 0, 0, 0], null, undefined]);
        expect(out[1]).toBe(null);
        expect(out[2]).toBe(undefined);
    });

    it('coerces absent slots to null when empty=null (save serialization)', () => {
        const out = clonePositions([[0, 0, 0, 0], undefined, null], null);
        expect(out[1]).toBe(null);
        expect(out[2]).toBe(null);
    });

    it('coerces absent slots to undefined when empty=undefined (load path)', () => {
        const out = clonePositions([[0, 0, 0, 0], null], undefined);
        expect(out[1]).toBe(undefined);
    });
});
