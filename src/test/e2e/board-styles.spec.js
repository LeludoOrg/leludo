import { test, expect } from '@playwright/test';
import { startGame as bootGame } from './helpers.js';

/**
 * Regression suite for board CSS.
 *
 * These assertions exist because the Tailwind → hand-written CSS
 * refactor introduced specificity bugs that broke board visuals
 * (corner pills lost player color, home-stretch path cells lost their
 * tint, grid cell sizes drifted, animate-bounce tokens clipped at the
 * board edge). Keep them green to catch the same class of regression
 * if the CSS layering changes again.
 */

const HSL_RE = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/;

async function startGame(page) {
    await bootGame(page);
    // wait for at least one corner widget to populate so we can read pill styles
    await page.locator('.corner-widget').first().waitFor();
}

test.describe('Board grid layout', () => {
    test('all 72 path cells render at identical width and height', async ({ page }) => {
        await startGame(page);

        const sizes = await page.evaluate(() => {
            const cells = Array.from(document.querySelectorAll('wc-board .path-cell'));
            return cells.map(c => {
                const r = c.getBoundingClientRect();
                // round to one decimal so sub-pixel layout noise doesn't fail
                return { id: c.id, w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 };
            });
        });

        expect(sizes.length).toBe(72);
        const widths = new Set(sizes.map(s => s.w));
        const heights = new Set(sizes.map(s => s.h));
        expect([...widths]).toHaveLength(1);
        expect([...heights]).toHaveLength(1);
        // cells should be square (within rounding tolerance)
        const [w] = [...widths];
        const [h] = [...heights];
        expect(Math.abs(w - h)).toBeLessThanOrEqual(0.5);
    });

    test('board-grid does NOT clip overflow (animate-bounce + drop shadows extend past edge)', async ({ page }) => {
        await startGame(page);
        const overflow = await page.evaluate(() =>
            getComputedStyle(document.querySelector('wc-board .board-grid')).overflow
        );
        expect(overflow).toBe('visible');
    });
});

test.describe('Path cell backgrounds', () => {
    test('plain path cells render at board-cell color (not blank/transparent)', async ({ page }) => {
        await startGame(page);
        const bg = await page.evaluate(() =>
            getComputedStyle(document.getElementById('m1')).backgroundColor
        );
        expect(bg).toMatch(HSL_RE);
        const [, r, g, b] = bg.match(HSL_RE).map(Number);
        // light theme --color-board-cell is hsl(42 38% 95%) ~ rgb(247,244,237).
        // accept anything that's clearly not transparent (alpha 0) and not white.
        expect(r).toBeGreaterThan(200);
        expect(g).toBeGreaterThan(200);
    });

    test('home-stretch cells (player-bg-path-N) use the player tint, not board-cell', async ({ page }) => {
        await startGame(page);

        const sample = await page.evaluate(() => {
            const ids = ['p0s1', 'p1s1', 'p2s1', 'p3s1'];
            const plain = getComputedStyle(document.getElementById('m1')).backgroundColor;
            const map = {};
            for (const id of ids) {
                map[id] = getComputedStyle(document.getElementById(id)).backgroundColor;
            }
            return { plain, map };
        });

        // Each player's home-stretch cell must differ from the plain board-cell.
        for (const [id, bg] of Object.entries(sample.map)) {
            expect(bg, `${id} should not match plain board-cell color ${sample.plain}`).not.toBe(sample.plain);
        }
        // And they should all differ from each other (one tint per player).
        const tints = new Set(Object.values(sample.map));
        expect(tints.size).toBe(4);
    });

    test('safe (starred) cells share the plain board-cell background', async ({ page }) => {
        // Design call: safe squares (m8, m21, m34, m47) are visually
        // identical to plain path cells. The "safe" signal comes from
        // the player-colored star SVG drawn on top, not from a tinted
        // cell background. A regression that tints the cell (with
        // --color-safe or a player-path color) makes the cell read as
        // "grey" / out-of-place compared to its neighbours and breaks
        // this assertion.
        await startGame(page);

        const sample = await page.evaluate(() => {
            const ids = ['m8', 'm21', 'm34', 'm47'];
            const out = { plain: getComputedStyle(document.getElementById('m1')).backgroundColor };
            for (const id of ids) {
                out[id] = getComputedStyle(document.getElementById(id)).backgroundColor;
            }
            return out;
        });

        for (const id of ['m8', 'm21', 'm34', 'm47']) {
            expect(sample[id], `${id} should match plain board-cell color ${sample.plain}`).toBe(sample.plain);
        }
    });
});

test.describe('Corner widget (player pill)', () => {
    test('active pill background uses the active player color (not surface)', async ({ page }) => {
        await startGame(page);

        const data = await page.evaluate(() => {
            const active = document.querySelector('.corner-pill.corner-pill--active');
            const idle = document.querySelector('.corner-pill:not(.corner-pill--active)');
            const surface = getComputedStyle(document.documentElement).getPropertyValue('--color-surface').trim();
            return {
                activeBg: active ? getComputedStyle(active).backgroundColor : null,
                activeColor: active ? getComputedStyle(active).color : null,
                idleBg: idle ? getComputedStyle(idle).backgroundColor : null,
                surfaceVar: surface,
            };
        });

        expect(data.activeBg, 'active corner pill must have a background').not.toBeNull();
        expect(data.activeBg).toMatch(HSL_RE);

        // Active pill text must be white-ish (we set color:#fff explicitly).
        expect(data.activeColor).toMatch(/^rgb\(255,\s*255,\s*255\)$/);

        // Active pill background should NOT match the idle (surface) pill.
        if (data.idleBg) {
            expect(data.activeBg).not.toBe(data.idleBg);
        }
    });

    test('idle pill uses surface color, not transparent', async ({ page }) => {
        await startGame(page);
        const idleBg = await page.evaluate(() => {
            const idle = document.querySelector('.corner-pill:not(.corner-pill--active)');
            return idle ? getComputedStyle(idle).backgroundColor : null;
        });
        expect(idleBg).toBeTruthy();
        // rgba(0,0,0,0) is transparent — must NOT be that
        expect(idleBg).not.toBe('rgba(0, 0, 0, 0)');
    });
});

test.describe('Token animation speed', () => {
    test('wc-token uses ~150ms transform transition (matches pre-refactor)', async ({ page }) => {
        // scripts/render-logic.js animates each per-cell hop by setting
        // wc-token.style.transform; the CSS transition-duration on the
        // wc-token element drives the resulting move speed. A regression
        // that ratchets this up (e.g. to 300ms) makes the game feel
        // sluggish. Pin it to the pre-refactor Tailwind value (150ms).
        await page.goto('/');
        const dur = await page.evaluate(() => {
            // wc-token only renders inside a board, so make a temporary
            // probe element to read the CSS rule's resolved duration.
            const el = document.createElement('wc-token');
            el.style.cssText = 'position:absolute;top:-9999px;left:0;width:1px;height:1px;';
            document.body.appendChild(el);
            const cs = getComputedStyle(el);
            const out = { duration: cs.transitionDuration, property: cs.transitionProperty };
            el.remove();
            return out;
        });
        expect(dur.property).toContain('transform');
        expect(dur.duration).toBe('0.15s');
    });
});

test.describe('Token rendering inside cells', () => {
    test('peek-fan: ≤4 pawns sit at the cell floor and may rise above it', async ({ page }) => {
        // Two guards bundled here:
        //  1. wc-token's inner <svg> was once inline by default, so the line-box
        //     baseline strut pushed the rendered svg ~4–5px BELOW the wc-token
        //     box — on small (24px) cells stacked pawns fell below the border.
        //     Fix: wc-token svg { display:block } — removes the strut. The pawn
        //     base must never sit below the cell floor.
        //  2. The peek-fan redesign anchors pawns at the cell's bottom-center
        //     and lets the (taller-than-cell) pawns OVERFLOW upward — that's
        //     intentional, so DON'T re-add a "must stay below cell top" assert.
        await bootGame(page, '?positions=39,39,39,39&player=0');

        const data = await page.evaluate(async () => {
            const mod = await import('/scripts/render/render-logic.js');
            const cell = document.getElementById('m39');
            mod.updateCellStacking(cell);
            const cellRect = cell.getBoundingClientRect();
            return Array.from(cell.querySelectorAll('wc-token')).map(t => {
                const svg = t.querySelector('svg');
                const sr = svg.getBoundingClientRect();
                return {
                    svgBottom: sr.bottom,
                    cellBottom: cellRect.bottom,
                    svgDisplay: getComputedStyle(svg).display,
                    svgTransform: getComputedStyle(svg).transform,
                    pos: getComputedStyle(t).position,
                };
            });
        });

        expect(data.length).toBe(4);
        for (const t of data) {
            expect(t.svgDisplay).toBe('block');
            // peek-fan pins each pawn absolutely in the cell…
            expect(t.pos).toBe('absolute');
            // …tilted via a rotate on the inner svg (matrix, not 'none')…
            expect(t.svgTransform).not.toBe('none');
            // …and the pawn base must not fall below the cell floor.
            expect(t.svgBottom - t.cellBottom).toBeLessThanOrEqual(0.5);
        }
    });

    test('yard pawn base disc clears the parking-ring bottom line (lifted, not sitting on it)', async ({ page }) => {
        // The pawn svg is taller than the round home-slot-dot (PAWN_ASPECT 1.16),
        // so a top-aligned yard pawn used to drop its base disc right onto the
        // ring's bottom stroke. Fix: `.home-slot-dot wc-token { translateY(-15%) }`
        // lifts the parked pawn so its base clears the ring with a margin.
        await startGame(page);

        const m = await page.evaluate(() => {
            const dot = document.querySelector('#h-0-0');
            const tok = dot.querySelector('wc-token');
            const svg = tok.querySelector('svg');
            const dr = dot.getBoundingClientRect();
            const sr = svg.getBoundingClientRect();
            // base disc bottom in the 0 0 100 116 viewBox: ellipse cy=101 ry=6.5
            const baseDiscBottom = sr.top + (107.5 / 116) * sr.height;
            return {
                transform: getComputedStyle(tok).transform,
                gap: dr.bottom - baseDiscBottom,
            };
        });

        // a real upward shift is applied (not the identity matrix)…
        expect(m.transform).not.toBe('none');
        // …and the base disc sits clearly inside the ring, off the bottom line.
        expect(m.gap).toBeGreaterThan(2);
    });

    test('a lone pawn on a track cell is floor-anchored, not cropped by the next cell', async ({ page }) => {
        // The pawn svg is taller than its (square) cell (PAWN_ASPECT 1.16). A
        // lone pawn left in normal flow top-aligned, so its base overflowed
        // BELOW the cell and the next-row cell — painted later — cropped it.
        // Fix: updateCellStacking floor-anchors a lone .path-cell pawn so the
        // excess height overflows upward instead. Pawns sit on vertical-arm
        // cells m11 & m12 here.
        await bootGame(page, '?positions=11,12&player=0');
        await page.locator('#m11 wc-token').waitFor();

        const data = await page.evaluate(() => {
            return ['m11', 'm12'].map((id) => {
                const cell = document.getElementById(id);
                const tok = cell.querySelector('wc-token');
                const svg = tok.querySelector('svg');
                const cr = cell.getBoundingClientRect();
                const sr = svg.getBoundingClientRect();
                return {
                    pos: getComputedStyle(tok).position,
                    belowFloor: sr.bottom - cr.bottom, // >0 means it spills below → croppable
                };
            });
        });

        for (const d of data) {
            // pinned out of flow…
            expect(d.pos).toBe('absolute');
            // …with the body sitting on the cell floor, never spilling below it
            // (the bottom spill is exactly what the neighbouring cell cropped).
            expect(d.belowFloor).toBeLessThanOrEqual(0.5);
        }
    });

    test('a gliding (moving) pawn keeps full size — same width as a settled pawn', async ({ page }) => {
        // Regression: the move-glide pins the mover position:absolute. It used
        // width:100%;height:100%, which squared the wrapper and letterboxed the
        // taller (1.16) pawn down to ~0.86× cell — the pawn visibly SHRANK while
        // hopping between cells. Fix: pin width:100%;height:auto so the height
        // follows the aspect, exactly like a lone settled token.
        await bootGame(page, '?positions=39,7&player=0');

        const r = await page.evaluate(() => {
            const cell = document.getElementById('m39');
            const cellW = cell.getBoundingClientRect().width;
            const settled = document.getElementById('p-0-0').firstElementChild.getBoundingClientRect();
            // Apply the exact styles updateTokenContainer sets on a mover.
            const mover = document.getElementById('p-0-1');
            mover.style.position = 'absolute';
            mover.style.left = '0';
            mover.style.top = '0';
            mover.style.width = '100%';
            mover.style.height = 'auto';
            const pinned = mover.firstElementChild.getBoundingClientRect();
            return { cellW, settledW: settled.width, pinnedW: pinned.width };
        });

        // Mover renders at the same width as a settled lone pawn (== one cell).
        expect(Math.abs(r.pinnedW - r.settledW)).toBeLessThanOrEqual(0.5);
        expect(Math.abs(r.pinnedW - r.cellW)).toBeLessThanOrEqual(0.5);
    });

});

test.describe('Finish-cell token stacking', () => {
    test('finished tokens get applyFinishStacking on game-start (not piled at 0,0)', async ({ page }) => {
        // Regression: handleGameStart (and handleGameResume) appended tokens
        // to p?s6 finish cells via plain appendChild without calling
        // updateCellStacking. Result: every finished token rendered at the
        // top-left of its finish-tri parent — which, combined with
        // clip-path on overlapping triangles, meant only P0's and P1's
        // finished tokens were visible (piled in top-left of finish-zone)
        // and P2/P3 finished tokens were clipped out entirely. To a user
        // this looked like "all finished tokens turned green" (P0 colormap).
        // Fix: handleGameStart + handleGameResume must updateCellStacking
        // on every cell they appended tokens into.
        await bootGame(page, '?positions=56,56,56,56,56,56,56,56,56,56,56,56,56,56,56,56');

        const data = await page.evaluate(() => {
            return ['p0s6', 'p1s6', 'p2s6', 'p3s6'].map(id => {
                const cell = document.getElementById(id);
                const tokens = Array.from(cell.querySelectorAll(':scope > wc-token'));
                return tokens.map(t => ({
                    cellId: id,
                    style: t.getAttribute('style') || '',
                }));
            }).flat();
        });

        expect(data.length).toBe(16);
        // every finished token must have absolute positioning applied
        // by applyFinishStacking (without it, tokens pile at 0,0 of cell)
        for (const t of data) {
            expect(t.style).toContain('position: absolute');
            expect(t.style).toMatch(/top:\s*\d+(\.\d+)?%/);
            expect(t.style).toMatch(/left:\s*\d+(\.\d+)?%/);
        }
    });

    test('finished pawns are a compact horizontal fan (width-driven, overlapping)', async ({ page }) => {
        // Finish cells use a compact HORIZONTAL peek-fan. Guards: (1) width-driven
        // (height ≈ width*1.16, NOT squared/letterboxed); (2) the 4 pawns fan
        // horizontally — lefts strictly increase, tops equal; (3) tightly overlap
        // (horizontal step well under one pawn width).
        await bootGame(page, '?positions=56,56,56,56,7,,,,&player=0');

        const r = await page.evaluate(() => {
            const finish = Array.from(document.getElementById('p0s6').querySelectorAll(':scope > wc-token'));
            const rect = finish[0].firstElementChild.getBoundingClientRect();
            return {
                count: finish.length,
                finishW: rect.width,
                finishH: rect.height,
                lefts: finish.map(t => parseFloat(t.style.left)),
                tops: finish.map(t => parseFloat(t.style.top)),
            };
        });

        expect(r.count).toBe(4);
        // width-driven, not letterboxed into a square
        expect(r.finishH / r.finishW).toBeGreaterThan(1.1);
        // horizontal fan: all on the same row, lefts increasing, tightly overlapped
        const wPct = 22, step = wPct * 0.28;
        for (let i = 1; i < r.count; i++) {
            expect(r.tops[i]).toBeCloseTo(r.tops[0], 1);              // same row
            expect(r.lefts[i]).toBeGreaterThan(r.lefts[i - 1]);      // fans rightward
            expect(r.lefts[i] - r.lefts[i - 1]).toBeLessThan(wPct);  // overlapping
            expect(r.lefts[i] - r.lefts[i - 1]).toBeCloseTo(step, 1);
        }
    });
});

test.describe('Capture animation', () => {
    test('animateCaptureToHome mounts the KO Punch overlay inside .board-wrap', async ({ page }) => {
        // KO Punch overlay replaces the old capture-blast/ring scale+fade.
        // The overlay (.kocap-root) must mount inside the board-wrap so the
        // POW! + flying defender pawn position correctly relative to the
        // capture cell, and must clean itself up when the promise resolves.
        await bootGame(page, '?positions=20,,,,7,,,,,,,,,,,,&player=0');
        await page.waitForFunction(() => {
            const v = document.getElementById('p-1-0');
            return v && v.parentElement?.id === 'm20';
        });
        const result = await page.evaluate(async () => {
            const mod = await import('/scripts/render/render-logic.js');
            mod.pinTokenForCapture(document.getElementById('p-1-0'));
            const anim = mod.animateCaptureToHome(1, 0, {
                attackerPlayerIndex: 0,
                attackerTokenIndex: 0,
                prevCellId: 'm19',
            });
            await new Promise((r) => setTimeout(r, 80));
            const wrap = document.querySelector('wc-board .board-wrap');
            const overlayMounted = !!wrap?.querySelector('.kocap-root');
            const hasPow = !!wrap?.querySelector('.kocap-pow svg');
            const hasFlyer = !!wrap?.querySelector('.kocap-pawn-wrap .kocap-pawn-svg');
            await anim;
            const overlayGone = !document.querySelector('.kocap-root');
            return { overlayMounted, hasPow, hasFlyer, overlayGone };
        });
        expect(result.overlayMounted).toBe(true);
        expect(result.hasPow).toBe(true);
        expect(result.hasFlyer).toBe(true);
        expect(result.overlayGone).toBe(true);
    });

    test('.token-arriving uses home-arrive keyframe', async ({ page }) => {
        // Second beat of the new capture animation: after the blast the
        // token reappears in its home cell with a fade-in + small overshoot.
        await page.goto('/');
        const animName = await page.evaluate(() => {
            const probe = document.createElement('wc-token');
            probe.className = 'token-arriving';
            probe.style.cssText = 'position:fixed;top:-1000px;width:10px;height:10px;';
            document.body.appendChild(probe);
            const name = getComputedStyle(probe).animationName;
            probe.remove();
            return name;
        });
        expect(animName).toBe('home-arrive');
    });

    test('capturing lander resizes to full cell after victim leaves (not stuck at 2-token stack size)', async ({ page }) => {
        // Regression: previously animateCaptureToHome ran
        // updateCellStacking(sourceCell) BEFORE moving the captured token
        // out of the cell, so it saw two settled tokens and shrunk the
        // capturing lander to ~64% — and never restacked once the victim
        // left, leaving the lander permanently small. Fix moves the
        // appendChild before the source restack.
        // Setup: P0 token 0 at m20 (pos 20, non-safe), P1 token 0 also
        // at m20 (pos 7, non-safe). Trigger animateCaptureToHome on P1.
        await bootGame(page, '?positions=20,,,,7,,,,,,,,,,,,&player=0');
        await page.waitForFunction(() => {
            const p0 = document.getElementById('p-0-0');
            const p1 = document.getElementById('p-1-0');
            return p0 && p1 && p0.parentElement?.id === 'm20' && p1.parentElement?.id === 'm20';
        });
        const result = await page.evaluate(async () => {
            const mod = await import('/scripts/render/render-logic.js');
            const lander = document.getElementById('p-0-0');
            const victim = document.getElementById('p-1-0');
            // Pin victim as the real flow does, so updateCellStacking
            // doesn't count it as a settled token while the lander is
            // settling.
            mod.pinTokenForCapture(victim);
            // Lander is settling in the same cell — restack to size it.
            mod.updateCellStacking(document.getElementById('m20'));
            await mod.animateCaptureToHome(1, 0);
            const cellRect = document.getElementById('m20').getBoundingClientRect();
            const landerRect = lander.getBoundingClientRect();
            return {
                landerInline: lander.getAttribute('style') || '',
                widthRatio: landerRect.width / cellRect.width,
                heightRatio: landerRect.height / cellRect.height,
            };
        });
        expect(result.landerInline).not.toMatch(/width:\s*64%/);
        expect(result.widthRatio).toBeGreaterThan(0.95);
        expect(result.heightRatio).toBeGreaterThan(0.95);
    });

    test('animateCaptureToHome moves token into its home cell', async ({ page }) => {
        // End-to-end: capture animation must always leave the token DOM-
        // attached to its home cell. Regression guard against the previous
        // backwards-walk path; the new blast-then-teleport must land the
        // token in h-{pi}-{ti} just as reliably.
        await bootGame(page, '?positions=1&player=0');
        await page.waitForFunction(() => !!document.querySelector('#h-0-0 wc-token, #m1 wc-token'));
        const result = await page.evaluate(async () => {
            const mod = await import('/scripts/render/render-logic.js');
            // Reuse P0's token 0 (positions=1 puts it at m1). Animate it
            // home as if captured.
            const token = document.getElementById('p-0-0');
            if (!token) return { ok: false, reason: 'no-token' };
            await mod.animateCaptureToHome(0, 0);
            return { ok: true, parentId: token.parentElement?.id };
        });
        expect(result.ok).toBe(true);
        expect(result.parentId).toBe('h-0-0');
    });
});

test.describe('Player color utilities', () => {
    test('.player-bg-N classes resolve to four distinct colors', async ({ page }) => {
        await page.goto('/');
        const colors = await page.evaluate(() => {
            const probe = document.createElement('div');
            probe.style.cssText = 'position:fixed;top:-1000px;width:10px;height:10px;';
            document.body.appendChild(probe);
            const out = [];
            for (let i = 0; i < 4; i++) {
                probe.className = `player-bg-${i}`;
                out.push(getComputedStyle(probe).backgroundColor);
            }
            probe.remove();
            return out;
        });
        expect(new Set(colors).size).toBe(4);
        for (const c of colors) expect(c).toMatch(HSL_RE);
    });
});

test.describe('Tap highlight', () => {
    // Tapping a button (e.g. the settings gear) on touch devices used to
    // flash the browser's default blue/grey highlight block. We disable
    // -webkit-tap-highlight-color globally so buttons only show their own
    // hover/press styling. Assert it resolves to transparent.
    test('default tap-highlight is disabled (transparent)', async ({ page }) => {
        await page.goto('/');
        const highlight = await page.evaluate(() =>
            getComputedStyle(document.documentElement).webkitTapHighlightColor
        );
        // transparent serializes as rgba(0, 0, 0, 0)
        expect(highlight).toBe('rgba(0, 0, 0, 0)');
    });
});

test.describe('FX overlay stacking', () => {
    // Pawn-step / pawn-launch / ko-capture overlays mount into .board-wrap at
    // z-index:1000 (OVERLAY_Z). The wrap MUST create its own stacking context
    // (isolation: isolate) so that z stays local to the board. Without it,
    // pausing mid-hop left the animating pawn copy painting ABOVE the
    // root-level pause / settings / game-end overlays (z 50–70) — the pawn
    // was visible on top of the "Take a breather" pause screen.
    test('.board-wrap isolates so FX overlay z-index stays below page overlays', async ({ page }) => {
        await startGame(page);
        const isolation = await page.evaluate(() =>
            getComputedStyle(document.querySelector('wc-board .board-wrap')).isolation
        );
        expect(isolation).toBe('isolate');
    });

    test('an FX overlay in .board-wrap renders behind the shown pause menu', async ({ page }) => {
        await startGame(page);
        // Simulate a gameplay FX overlay mid-animation (same layer the real
        // pawn-step overlay uses), then show the pause menu, and assert the
        // pause menu wins the stacking order at the overlay's center point.
        const onTopIsPauseMenu = await page.evaluate(() => {
            const wrap = document.querySelector('wc-board .board-wrap');
            const fx = document.createElement('div');
            fx.id = '__fx-probe';
            fx.style.cssText =
                'position:absolute;inset:0;z-index:1000;background:rgba(255,0,0,1);';
            wrap.appendChild(fx);

            const pause = document.getElementById('pause-menu');
            pause.classList.remove('hidden');

            const r = pause.getBoundingClientRect();
            const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
            const wins = pause.contains(top) || top === pause;

            fx.remove();
            pause.classList.add('hidden');
            return wins;
        });
        expect(onTopIsPauseMenu).toBe(true);
    });
});
