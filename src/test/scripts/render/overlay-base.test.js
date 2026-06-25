import { describe, it, expect } from 'vitest';
import { boxAt } from '../../../scripts/render/overlay-base.js';

// boxAt collapsed the left/top/width/height CSS string the three FX overlays
// hand-built per sprite. These assertions pin the exact output the call sites
// produced before extraction, so a future tweak can't silently shift sprites.
describe('boxAt', () => {
    it('centres a square sprite on (x, y)', () => {
        expect(boxAt(100, 50, 20)).toBe('left:90px;top:40px;width:20px;height:20px;');
    });

    it('supports a non-square sprite via an explicit height', () => {
        expect(boxAt(100, 50, 20, 10)).toBe('left:90px;top:45px;width:20px;height:10px;');
    });

    it('adds the vertical offset to top (FX dropped to a pawn\'s feet)', () => {
        // top = 50 - 20/2 + 5 = 45
        expect(boxAt(100, 50, 20, 20, 5)).toBe('left:90px;top:45px;width:20px;height:20px;');
    });
});
