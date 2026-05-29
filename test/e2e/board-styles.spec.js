import { test, expect } from '@playwright/test';

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
    await page.goto('/');
    await page.locator('.new-game-btn').click();
    await page.locator('.start-btn').click();
    await page.locator('wc-board:not(.hidden)').waitFor();
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
    test('stacked tokens stay inside the cell (no inline baseline overflow)', async ({ page }) => {
        // Regression: wc-token's inner <svg> was inline by default, so the
        // line-box baseline strut pushed the rendered svg ~4–5px below the
        // wc-token box. On small viewports (24px cells) the pawns visibly
        // fell below the cell border when 2+ tokens shared a cell.
        // Fix: wc-token svg { display: block; } — removes the strut.
        await page.goto('/?positions=39,39,39,39&player=0');
        await page.locator('.new-game-btn').click();
        await page.locator('.start-btn').click();
        await page.locator('wc-board:not(.hidden)').waitFor();

        const data = await page.evaluate(async () => {
            const mod = await import('/scripts/render-logic.js');
            const cell = document.getElementById('m39');
            mod.updateCellStacking(cell);
            const cellRect = cell.getBoundingClientRect();
            return Array.from(cell.querySelectorAll('wc-token')).map(t => {
                const svg = t.querySelector('svg');
                const sr = svg.getBoundingClientRect();
                return {
                    svgBottom: sr.bottom,
                    cellBottom: cellRect.bottom,
                    svgTop: sr.top,
                    cellTop: cellRect.top,
                    svgDisplay: getComputedStyle(svg).display,
                };
            });
        });

        expect(data.length).toBe(4);
        for (const t of data) {
            expect(t.svgDisplay).toBe('block');
            // svg must not extend below the cell (tolerate 0.5px sub-pixel)
            expect(t.svgBottom - t.cellBottom).toBeLessThanOrEqual(0.5);
            // svg must not extend above the cell either
            expect(t.cellTop - t.svgTop).toBeLessThanOrEqual(0.5);
        }
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
        await page.goto('/?positions=56,56,56,56,56,56,56,56,56,56,56,56,56,56,56,56');
        await page.locator('.new-game-btn').click();
        await page.locator('.start-btn').click();
        await page.locator('wc-board:not(.hidden)').waitFor();

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
});

test.describe('Capture animation', () => {
    test('animateCaptureToHome mounts the KO Punch overlay inside .board-wrap', async ({ page }) => {
        // KO Punch overlay replaces the old capture-blast/ring scale+fade.
        // The overlay (.kocap-root) must mount inside the board-wrap so the
        // POW! + flying defender pawn position correctly relative to the
        // capture cell, and must clean itself up when the promise resolves.
        await page.goto('/?positions=20,,,,7,,,,,,,,,,,,&player=0');
        await page.locator('.new-game-btn').click();
        await page.locator('.start-btn').click();
        await page.locator('wc-board:not(.hidden)').waitFor();
        await page.waitForFunction(() => {
            const v = document.getElementById('p-1-0');
            return v && v.parentElement?.id === 'm20';
        });
        const result = await page.evaluate(async () => {
            const mod = await import('/scripts/render-logic.js');
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
        await page.goto('/?positions=20,,,,7,,,,,,,,,,,,&player=0');
        await page.locator('.new-game-btn').click();
        await page.locator('.start-btn').click();
        await page.locator('wc-board:not(.hidden)').waitFor();
        await page.waitForFunction(() => {
            const p0 = document.getElementById('p-0-0');
            const p1 = document.getElementById('p-1-0');
            return p0 && p1 && p0.parentElement?.id === 'm20' && p1.parentElement?.id === 'm20';
        });
        const result = await page.evaluate(async () => {
            const mod = await import('/scripts/render-logic.js');
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
        await page.goto('/?positions=1&player=0');
        await page.locator('.new-game-btn').click();
        await page.locator('.start-btn').click();
        await page.locator('wc-board:not(.hidden)').waitFor();
        await page.waitForFunction(() => !!document.querySelector('#h-0-0 wc-token, #m1 wc-token'));
        const result = await page.evaluate(async () => {
            const mod = await import('/scripts/render-logic.js');
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
