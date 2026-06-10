import { describe, it, expect } from 'vitest';
import { pick, randInt } from '../../scripts/rng-util.js';

// A deterministic fake rng that yields a fixed sequence of 0..1 values,
// cycling. Lets us assert exactly which index/element gets chosen.
function fakeRng(values) {
    let i = 0;
    return () => values[i++ % values.length];
}

describe('randInt', () => {
    it('maps rng() to 0..n-1 via floor(rng()*n)', () => {
        const rng = fakeRng([0, 0.25, 0.5, 0.75, 0.999]);
        expect(randInt(4, rng)).toBe(0);   // floor(0   * 4) = 0
        expect(randInt(4, rng)).toBe(1);   // floor(0.25* 4) = 1
        expect(randInt(4, rng)).toBe(2);   // floor(0.5 * 4) = 2
        expect(randInt(4, rng)).toBe(3);   // floor(0.75* 4) = 3
        expect(randInt(4, rng)).toBe(3);   // floor(0.999*4) = 3
    });

    it('defaults to Math.random and stays in range', () => {
        for (let i = 0; i < 100; i++) {
            const v = randInt(5);
            expect(v).toBeGreaterThanOrEqual(0);
            expect(v).toBeLessThan(5);
            expect(Number.isInteger(v)).toBe(true);
        }
    });
});

describe('pick', () => {
    it('returns the element at the rng-chosen index', () => {
        const arr = ['a', 'b', 'c', 'd'];
        expect(pick(arr, fakeRng([0]))).toBe('a');
        expect(pick(arr, fakeRng([0.5]))).toBe('c');
        expect(pick(arr, fakeRng([0.999]))).toBe('d');
    });

    it('works on strings (array-like)', () => {
        expect(pick('XYZ', fakeRng([0.5]))).toBe('Y');
    });

    it('defaults to Math.random and returns a member of the array', () => {
        const arr = [10, 20, 30];
        for (let i = 0; i < 50; i++) {
            expect(arr).toContain(pick(arr));
        }
    });
});
