import { describe, it, expect } from 'vitest';
import { pawnSVG } from '../../../scripts/render/pawn-shape.js';

// The resting yard pawn used to fuse with its same-colour socket ring: both
// were the player colour and the body's only edge was a colour-mixed dark
// stroke, so the two read as one blob. The design handoff fixed it on the
// shared glyph itself — a near-black, theme-tuned outline on body + head, and
// a two-layer base disc (own colour + soft black) the pawn stands on. These
// assertions guard that treatment so a future tweak can't quietly revert it.
describe('pawnSVG glyph', () => {
    const svg = pawnSVG('red', 40, 'cls', 'uid-');

    it('strokes body + head with the theme-tuned near-black outline token', () => {
        // body path and head circle both reference the CSS var (flips dark/light)
        const strokes = svg.match(/stroke:var\(--pawn-outline\);stroke-width:var\(--pawn-outline-w\)/g);
        expect(strokes).toHaveLength(2);
        // the old colour-mixed stroke must NOT be on the body/head any more
        expect(svg).not.toMatch(/fill:red;stroke:color-mix[^"]*;stroke-width:1\.4/);
    });

    it('draws a two-layer base disc — own colour then soft black overlay', () => {
        expect(svg).toContain('<ellipse cx="50" cy="101" rx="26" ry="6.5" style="fill:red"/>');
        expect(svg).toContain('<ellipse cx="50" cy="101" rx="26" ry="6.5" style="fill:#000;opacity:0.1"/>');
    });

    it('leaves the collar on its colour-mixed edge (unchanged by the handoff)', () => {
        expect(svg).toContain('stroke:color-mix(in srgb, red 64%, #000);stroke-width:1');
    });

    it('keeps flat ghosts outline-free (launch-trail silhouettes)', () => {
        const flat = pawnSVG('red', 40, 'cls', 'uid-', { flat: true });
        expect(flat).not.toContain('--pawn-outline');
        expect(flat).not.toContain('stroke');
    });
});
