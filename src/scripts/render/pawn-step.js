// Pawn Step overlay — energetic cell-to-cell hop-and-skip mover.
//
// Plays when a pawn advances the rolled number of cells during a turn. Instead
// of a flat slide, the pawn skips: it snaps across each cell gap, pops up in an
// alternating big-hop / low-skip rhythm, squashes on take-off and landing while
// stretching tall mid-air, leans into the travel direction, and lands with a
// small settle bounce on the destination cell.
//
// Companion to pawn-launch.js (yard → entry leap), ko-capture.js (knocked out)
// and home-arrival.js (reaching the finish). Same conventions: self-injects its
// CSS once (`pstep-*`), takes per-call colors, paints its own pawn copy via the
// shared pawn-shape glyph, and resolves a Promise after DOM cleanup. The live
// on-board token is hidden by the caller while this plays and revealed after.
//
// playPawnStep({
//   container,          HTMLElement (position: relative/absolute) the overlay
//                       mounts into — pass the .board-wrap.
//   path,               REQUIRED. Array of {x,y} pixel FEET points (the pawn's
//                       bottom-center contact point, length >= 2) relative to
//                       container top-left. The pawn hops path[0] → path[1] → …
//                       in order. Feet (not cell-center) so the end frame lands
//                       exactly where a floor-anchored on-board token settles.
//   color,              hex/hsl pawn fill (the team color).
//   pawnSize,           px WIDTH of the pawn (height = width * PAWN_ASPECT) —
//                       pass cellSize so it matches the on-board wc-token.
//                       default 48.
//   stepDur = 260,      ms spent travelling each cell gap.
//   hopBig = 0.64,      big-hop height as a fraction of the gap distance.
//   hopSkip = 0.34,     low-skip (off-beat) height as a fraction of the gap.
//   alternate = true,   swing big / low hops. false = every hop is hopBig.
//   squash = 0.11,      squash-&-stretch amount (0 = rigid). Kept modest so the
//                       pawn never reads as too slim at the mid-air apex.
//   lean = 11,          max lean in degrees, into the travel direction.
//   landBounce = true,  settle bounce on the final cell.
//   onStep,             optional (index) => {} fired as each cell is reached.
//   onComplete,         optional callback after cleanup.
// }) → Promise<void>

import { pawnSVG } from "./pawn-shape.js";
import { PAWN_ASPECT } from "./pawn-shape.js";
import {
    el,
    boxAt,
    injectOnce,
    createOverlayRoot,
    overlayRootCSS,
} from "./overlay-base.js";

const STYLE_ID = 'pstep-styles';

// Final, tuned motion constants (see the handoff): the design is fixed, so the
// curve shapes live here rather than as caller knobs.
const TRAVEL_ARRIVE = 0.85;   // horizontal reaches the next cell at 85% of the gap, then settles
const HOP_APEX_SKEW = 0.74;   // pow(frac, …) skews the apex early — sharp pop, brief hang, quick drop
const SQUASH_STOPS = [0, 0.12, 0.5, 0.86, 1];
const SQUASH_VALS  = [1, -1, -1.2, -0.4, 1.2];
const LEAN_STOPS   = [0, 0.5, 1];
const LEAN_VALS    = [-1, 0.64, -0.18];
const BOUNCE_DUR   = 320;
const BOUNCE_EASE  = 'cubic-bezier(.3,1.5,.4,1)';

function injectCSS() {
    injectOnce(STYLE_ID, `
      ${overlayRootCSS('pstep-root')}
      .pstep-pawn-wrap {
        position: absolute;
        transform-origin: center bottom;
        will-change: transform;
      }
      .pstep-pawn-svg {
        display: block;
        filter: drop-shadow(0 4px 9px rgba(0,0,0,0.45));
      }
      .pstep-shadow {
        position: absolute;
        border-radius: 50%;
        background: radial-gradient(circle,
          rgba(0,0,0,0.45) 0%, rgba(0,0,0,0.32) 45%, transparent 72%);
        pointer-events: none;
        will-change: transform, opacity;
      }
    `);
}

function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function easeOutCubic(x) { return 1 - Math.pow(1 - x, 3); }

// Piecewise-linear interpolation across stop/value arrays.
function pw(stops, vals, t) {
    if (t <= stops[0]) return vals[0];
    const n = stops.length;
    if (t >= stops[n - 1]) return vals[n - 1];
    for (let i = 1; i < n; i++) {
        if (t <= stops[i]) {
            const f = (t - stops[i - 1]) / (stops[i] - stops[i - 1]);
            return vals[i - 1] + (vals[i] - vals[i - 1]) * f;
        }
    }
    return vals[n - 1];
}

function prefersReducedMotion() {
    return typeof window !== 'undefined' &&
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function playPawnStep(opts) {
    if (!opts || !opts.container || !opts.path || opts.path.length < 2) {
        throw new Error('playPawnStep: container and path[>=2] are required');
    }
    injectCSS();

    const container  = opts.container;
    const path       = opts.path;
    const color      = opts.color || '#cf4a3a';
    const pawnSize   = opts.pawnSize || 48;
    const stepDur    = opts.stepDur != null ? opts.stepDur : 260;
    const hopBig     = opts.hopBig != null ? opts.hopBig : 0.64;
    const hopSkip    = opts.hopSkip != null ? opts.hopSkip : 0.34;
    const alternate  = opts.alternate !== false;
    const squash     = opts.squash != null ? opts.squash : 0.11;
    const lean       = opts.lean != null ? opts.lean : 11;
    const landBounce = opts.landBounce !== false;
    const onStep     = opts.onStep || function () {};
    const onComplete = opts.onComplete || function () {};

    const steps    = path.length - 1;
    const totalDur = steps * stepDur;
    const p0       = path[0];
    const last     = path[steps];
    const pawnH    = pawnSize * PAWN_ASPECT;

    const root = createOverlayRoot(container, 'pstep-root');

    // Soft contact shadow centered on the feet point; shrinks + fades as the
    // pawn lifts.
    const shW = pawnSize * 0.9;
    const shH = shW * 0.34;
    const shadow = el('pstep-shadow', boxAt(p0.x, p0.y, shW, shH));
    root.appendChild(shadow);

    // Pawn wrap: width × (width·PAWN_ASPECT) box whose BOTTOM-CENTER sits on the
    // feet point path[0]. The glyph fills the wrap, so its base aligns with the
    // feet and the wrap's bottom edge IS the contact line — making the hop's end
    // frame match a floor-anchored on-board token's box exactly (no settle pop).
    // transform-origin center bottom pivots all squash/lean at the feet.
    const pawn = el('pstep-pawn-wrap',
        `left:${p0.x - pawnSize / 2}px;top:${p0.y - pawnH}px;width:${pawnSize}px;height:${pawnH}px;`);
    pawn.innerHTML = pawnSVG(color, pawnSize, 'pstep-pawn-svg', 'pstep-grad-');
    root.appendChild(pawn);

    let resolveFn;
    const promise = new Promise(resolve => { resolveFn = resolve; });

    function done() {
        if (root.parentNode) root.parentNode.removeChild(root);
        onComplete();
        if (resolveFn) resolveFn();
    }

    // Reduced motion: skip the hop choreography and snap to the destination.
    if (prefersReducedMotion()) {
        for (let i = 1; i <= steps; i++) onStep(i - 1);
        pawn.style.transform =
            `translate(${(last.x - p0.x).toFixed(2)}px,${(last.y - p0.y).toFixed(2)}px)`;
        shadow.style.transform = pawn.style.transform;
        setTimeout(done, 80);
        return promise;
    }

    let lastStep = -1;
    let start = null;

    function render(now) {
        if (start === null) start = now;
        const t = now - start;
        const sf = clamp(t / stepDur, 0, steps);
        const si = Math.min(Math.floor(sf), steps - 1);
        const frac = clamp(sf - si, 0, 1);

        if (si > lastStep) { lastStep = si; onStep(si); }

        const a = path[si], b = path[si + 1];
        const dx = b.x - a.x, dy = b.y - a.y;
        const gap = Math.hypot(dx, dy) || 1;

        // Horizontal: snap across, arrive ~85% through, then settle (skip beat).
        const travel = easeOutCubic(clamp(frac / TRAVEL_ARRIVE, 0, 1));
        const x = a.x + dx * travel;
        const y = a.y + dy * travel;

        // Alternating big / low hop rhythm — a skipping gait, not uniform bounces.
        const big = alternate ? (si % 2 === 0) : true;
        const hScale = big ? hopBig : hopSkip;
        const hop = -Math.sin(Math.pow(frac, HOP_APEX_SKEW) * Math.PI) * gap * hScale;
        const lift = -hop / (gap * Math.max(hopBig, 0.001)); // 0..1 normalized height

        // Squash on take-off & landing, stretch tall mid-air.
        const prof = pw(SQUASH_STOPS, SQUASH_VALS, frac);
        const scaleX = 1 + squash * prof;
        const scaleY = 2 - scaleX;

        // Lean into the travel direction (forward at apex, settle on landing).
        const dirX = dx > 0.01 ? 1 : dx < -0.01 ? -1 : 0;
        const leanProf = pw(LEAN_STOPS, LEAN_VALS, frac) * (big ? 1 : 0.6);
        const rot = leanProf * lean * dirX;

        pawn.style.transform =
            `translate(${(x - p0.x).toFixed(2)}px,${((y - p0.y) + hop).toFixed(2)}px) ` +
            `rotate(${rot.toFixed(2)}deg) scaleX(${scaleX.toFixed(3)}) scaleY(${scaleY.toFixed(3)})`;

        const sScale = 1 - lift * 0.5;
        shadow.style.transform =
            `translate(${(x - p0.x).toFixed(2)}px,${(y - p0.y).toFixed(2)}px) scale(${sScale.toFixed(3)})`;
        shadow.style.opacity = (0.85 - lift * 0.55).toFixed(3);

        if (t < totalDur) {
            requestAnimationFrame(render);
        } else {
            finish();
        }
    }

    function finish() {
        const baseT = `translate(${(last.x - p0.x).toFixed(2)}px,${(last.y - p0.y).toFixed(2)}px)`;
        shadow.style.transform = baseT + ' scale(1)';
        shadow.style.opacity = '0.85';
        pawn.style.transform = baseT;

        if (landBounce && typeof pawn.animate === 'function') {
            pawn.animate(
                [
                    { transform: baseT + ' scaleX(1) scaleY(1)' },
                    { transform: baseT + ` scaleX(${(1 + squash * 1.4).toFixed(3)}) scaleY(${(1 - squash * 1.4).toFixed(3)})`, offset: 0.25 },
                    { transform: baseT + ` scaleX(${(1 - squash * 0.7).toFixed(3)}) scaleY(${(1 + squash * 0.7).toFixed(3)})`, offset: 0.6 },
                    { transform: baseT + ' scaleX(1) scaleY(1)' },
                ],
                { duration: BOUNCE_DUR, easing: BOUNCE_EASE, fill: 'forwards' }
            );
            setTimeout(done, BOUNCE_DUR + 40);
        } else {
            setTimeout(done, 40);
        }
    }

    requestAnimationFrame(render);
    return promise;
}
