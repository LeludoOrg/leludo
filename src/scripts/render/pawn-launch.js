// Pawn Launch overlay — pawn leaves its yard and lands on its entry cell on
// the track. Self-contained DOM/style. Companion to ko-capture.js and
// home-arrival.js; shares the pawn shape with them via pawn-shape.js.
//
// playPawnLaunch({
//   container,             HTMLElement (position: relative/absolute)
//   yard:  {x, y},         REQUIRED. px center of yard parking dot,
//                          relative to container's top-left.
//   entry: {x, y},         REQUIRED. px center of entry cell on track,
//                          relative to container's top-left.
//   color,                 hex — pawn fill + halo + trail + shockwave + chip
//   pawnSize,              px height of pawn (~1.2–1.5× cell size). default 48
//   duration,              total ms. default 1500
//   arcHeight,             optional — px the pawn rises above the straight
//                          line at apex. Default: max(distance*0.32, pawnSize*1.4)
//   trail,                 bool — ghost-trail copies during the leap. default true
//   label,                 string on the chip. default 'GO!'. '' to hide.
//   onComplete,            optional callback fired after cleanup
// }) → Promise<void>

import { pawnSVG } from "./pawn-shape.js";
import {
    el,
    injectOnce,
    createOverlayRoot,
    scheduleCleanup,
    overlayRootCSS,
    arcPoint,
    CLEANUP_MARGIN_MS,
    EASE_SETTLE,
    EASE_BURST,
} from "./overlay-base.js";

const STYLE_ID = 'plnch-styles';

// 'GO!' chip readability: chip plays at the start of the landing phase.
// On short overlays the default `duration + 80` cleanup chopped the chip
// off after ~300ms — the user couldn't read it. We hold the chip for
// CHIP_VISIBLE_MS and stretch the overlay's resolve timer so cleanup
// waits for the chip to finish.
const CHIP_DELAY_MS = 60;
const CHIP_VISIBLE_MS = 1100;

function injectCSS() {
    injectOnce(STYLE_ID, `
      ${overlayRootCSS('plnch-root')}
      .plnch-pawn-wrap {
        position: absolute;
        transform-origin: center 86%;
        will-change: transform;
      }
      .plnch-pawn-svg  {
        display: block;
        filter: drop-shadow(0 4px 10px rgba(0,0,0,0.45));
      }
      .plnch-trail-wrap {
        position: absolute;
        transform-origin: center 86%;
        opacity: 0;
        will-change: transform, opacity;
      }
      .plnch-trail-svg  { display: block; }

      .plnch-halo {
        position: absolute;
        border-radius: 50%;
        background: radial-gradient(
          circle,
          currentColor 0%,
          currentColor 40%,
          transparent 72%
        );
        opacity: 0;
        pointer-events: none;
        mix-blend-mode: screen;
      }

      .plnch-ring {
        position: absolute;
        border-radius: 50%;
        border: 3px solid currentColor;
        opacity: 0;
        pointer-events: none;
      }

      .plnch-spark {
        position: absolute;
        border-radius: 999px;
        opacity: 0;
        pointer-events: none;
      }

      .plnch-dust {
        position: absolute;
        border-radius: 50%;
        opacity: 0;
        pointer-events: none;
      }

      .plnch-label {
        position: absolute;
        font-family: 'JetBrains Mono', ui-monospace, monospace;
        font-weight: 800; letter-spacing: 2px;
        text-align: center;
        opacity: 0;
        transform-origin: center;
        white-space: nowrap;
        pointer-events: none;
      }
      .plnch-label .plnch-label-chip {
        display: inline-block;
        padding: 6px 14px;
        border-radius: 999px;
        /* var() chain: --plnch-chip-bg flows down from the inline style on
         * .plnch-label (set in playLandingFX). Using currentColor here was
         * wrong — it resolves against the chip's OWN color (#1a1410), not
         * the parent's color, so the pill rendered as a dark "rounded
         * square" instead of the player color. */
        background: var(--plnch-chip-bg, currentColor);
        color: #1a1410;
        box-shadow: 0 6px 18px rgba(0,0,0,0.35);
      }
    `);
}

// Tangent angle (rad) of the arc at p. Used to tilt the pawn into the leap.
function arcAngle(yard, entry, p, arcH) {
    const dx = entry.x - yard.x;
    const dy = (entry.y - yard.y) - arcH * 4 * (1 - 2 * p);
    return Math.atan2(dy, dx);
}

export function playPawnLaunch(opts) {
    if (!opts || !opts.container || !opts.yard || !opts.entry) {
        throw new Error('playPawnLaunch: container, yard and entry are required');
    }
    injectCSS();

    const container  = opts.container;
    const yard       = opts.yard;
    const entry      = opts.entry;
    const color      = opts.color || '#d97644';
    const pawnSize   = opts.pawnSize || 48;
    const duration   = opts.duration || 1500;
    const trail      = opts.trail !== false;
    const label      = opts.label != null ? opts.label : 'GO!';
    const onComplete = opts.onComplete || function () {};

    const dist = Math.hypot(entry.x - yard.x, entry.y - yard.y);
    const arcH = opts.arcHeight != null
        ? opts.arcHeight
        : Math.max(dist * 0.32, pawnSize * 1.4);

    const root = createOverlayRoot(container, 'plnch-root');

    const T_anticipation = Math.round(duration * 0.28);
    const T_crouch       = Math.round(duration * 0.12);
    const T_leap         = Math.round(duration * 0.38);
    const T_land         = Math.round(duration * 0.22);

    const t_charge   = T_anticipation;
    const t_leap     = t_charge + T_crouch;
    const t_land     = t_leap + T_leap;

    // Pawn base (feet) offset below the wrap center. The square token SVG
    // draws its base ellipse at y=88/100, i.e. 0.38 below the centered
    // wrap — FX (halo/sparks/dust) anchor there so they sit at the feet.
    const baseY = pawnSize * 0.36;

    const haloSize = pawnSize * 1.8;
    const halo = el(
        'plnch-halo',
        'left:' + (yard.x - haloSize / 2) + 'px;' +
        'top:'  + (yard.y - haloSize / 2 + baseY) + 'px;' +
        'width:' + haloSize + 'px; height:' + haloSize + 'px;' +
        'color:' + color + ';'
    );
    root.appendChild(halo);
    halo.animate(
        [
            { opacity: 0,    transform: 'scale(0.4)' },
            { opacity: 0.55, transform: 'scale(0.85)', offset: 0.35 },
            { opacity: 0.85, transform: 'scale(1.0)',  offset: 0.7  },
            { opacity: 0,    transform: 'scale(1.25)' },
        ],
        { duration: T_anticipation + T_crouch + 60, easing: 'cubic-bezier(.4,.0,.5,1)', fill: 'forwards' }
    );

    const N_SPARK = 8;
    for (let i = 0; i < N_SPARK; i++) {
        const angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 0.9;
        const r0 = pawnSize * 0.45;
        const r1 = pawnSize * (0.9 + Math.random() * 0.6);
        const x0 = yard.x + Math.cos(angle) * r0;
        const y0 = yard.y + Math.sin(angle) * r0 + baseY;
        const x1 = yard.x + Math.cos(angle) * r1;
        const y1 = yard.y + Math.sin(angle) * r1 + baseY - pawnSize * 0.3;
        const sz = 3 + Math.random() * 3;
        const sp = el(
            'plnch-spark',
            'left:' + x0 + 'px; top:' + y0 + 'px;' +
            'width:' + sz + 'px; height:' + sz + 'px;' +
            'background:' + color + ';' +
            'box-shadow: 0 0 6px ' + color + ';'
        );
        root.appendChild(sp);
        sp.animate(
            [
                { opacity: 0, transform: 'translate(0,0) scale(0.6)' },
                { opacity: 1, transform: 'translate(0,0) scale(1)', offset: 0.15 },
                { opacity: 1, transform: 'translate(' + (x1 - x0).toFixed(1) + 'px,' + (y1 - y0).toFixed(1) + 'px) scale(0.7)', offset: 0.75 },
                { opacity: 0, transform: 'translate(' + (x1 - x0).toFixed(1) + 'px,' + (y1 - y0 - 6).toFixed(1) + 'px) scale(0.4)' },
            ],
            { duration: T_anticipation + T_crouch, delay: Math.round(Math.random() * 120), easing: 'ease-out', fill: 'forwards' }
        );
    }

    if (trail) {
        const N_TRAIL = 5;
        for (let i = 0; i < N_TRAIL; i++) {
            const p = (i + 1) / (N_TRAIL + 1);
            const pt = arcPoint(yard, entry, p, arcH);
            const tw = el(
                'plnch-trail-wrap',
                'left:' + (pt.x - pawnSize / 2) + 'px;' +
                'top:'  + (pt.y - pawnSize / 2) + 'px;' +
                'width:' + pawnSize + 'px; height:' + pawnSize + 'px;'
            );
            tw.innerHTML = pawnSVG(color, pawnSize, 'plnch-trail-svg', 'plnch-trail-', { flat: true });
            root.appendChild(tw);
            const ang = arcAngle(yard, entry, p, arcH);
            const tilt = (ang * 180 / Math.PI) * 0.18;
            tw.animate(
                [
                    { opacity: 0,    transform: 'scale(0.85) rotate(' + tilt + 'deg)' },
                    { opacity: 0.45 - i * 0.07, transform: 'scale(1) rotate(' + tilt + 'deg)', offset: 0.4 },
                    { opacity: 0,    transform: 'scale(0.9) rotate(' + tilt + 'deg)' },
                ],
                {
                    duration: Math.round(T_leap * 0.85),
                    delay: t_leap + Math.round(T_leap * p * 0.5),
                    easing: 'ease-out',
                    fill: 'forwards',
                }
            );
        }
    }

    const pawn = el(
        'plnch-pawn-wrap',
        'left:' + (yard.x - pawnSize / 2) + 'px;' +
        'top:'  + (yard.y - pawnSize / 2) + 'px;' +
        'width:' + pawnSize + 'px; height:' + pawnSize + 'px;'
    );
    pawn.innerHTML = pawnSVG(color, pawnSize, 'plnch-pawn-svg', 'plnch-grad-');
    root.appendChild(pawn);

    pawn.animate(
        [
            { transform: 'translate(0,0) scale(1, 1)' },
            { transform: 'translate(0,-' + (pawnSize * 0.10).toFixed(1) + 'px) scale(0.98, 1.04)', offset: 0.3 },
            { transform: 'translate(0,0) scale(1, 1)', offset: 0.55 },
            { transform: 'translate(0,-' + (pawnSize * 0.14).toFixed(1) + 'px) scale(0.97, 1.05)', offset: 0.82 },
            { transform: 'translate(0,0) scale(1, 1)' },
        ],
        { duration: T_anticipation, easing: 'cubic-bezier(.4,0,.6,1)', fill: 'forwards' }
    );

    setTimeout(function () {
        pawn.animate(
            [
                { transform: 'translate(0,0) scale(1, 1)' },
                { transform: 'translate(0,' + (pawnSize * 0.10).toFixed(1) + 'px) scale(1.15, 0.78)' },
            ],
            { duration: T_crouch, easing: 'cubic-bezier(.5,0,.7,.4)', fill: 'forwards' }
        );
    }, t_charge);

    setTimeout(function () {
        const STEPS = 12;
        const keyframes = [];
        for (let i = 0; i <= STEPS; i++) {
            const p = i / STEPS;
            const pt = arcPoint(yard, entry, p, arcH);
            const ang = arcAngle(yard, entry, p, arcH);
            const tilt = (ang * 180 / Math.PI) * 0.22;
            const tx = pt.x - yard.x;
            const ty = pt.y - yard.y;
            const ay = -Math.cos(p * Math.PI);
            const sx = 1 - ay * 0.04;
            const sy = 1 + ay * 0.06;
            keyframes.push({
                transform:
                    'translate(' + tx.toFixed(1) + 'px,' + ty.toFixed(1) + 'px) ' +
                    'rotate(' + tilt.toFixed(1) + 'deg) ' +
                    'scale(' + sx.toFixed(3) + ',' + sy.toFixed(3) + ')',
                offset: p,
            });
        }
        pawn.animate(keyframes, {
            duration: T_leap,
            easing: 'cubic-bezier(.45,.05,.55,.95)',
            fill: 'forwards',
        });
    }, t_leap);

    setTimeout(function () {
        const tx = entry.x - yard.x;
        const ty = entry.y - yard.y;
        pawn.animate(
            [
                { transform: 'translate(' + tx.toFixed(1) + 'px,' + ty.toFixed(1) + 'px) scale(1,1)' },
                { transform: 'translate(' + tx.toFixed(1) + 'px,' + (ty + 4).toFixed(1) + 'px) scale(1.18, 0.74)', offset: 0.25 },
                { transform: 'translate(' + tx.toFixed(1) + 'px,' + (ty - 6).toFixed(1) + 'px) scale(0.92, 1.10)', offset: 0.6 },
                { transform: 'translate(' + tx.toFixed(1) + 'px,' + ty.toFixed(1) + 'px) scale(1, 1)' },
            ],
            { duration: T_land, easing: EASE_SETTLE, fill: 'forwards' }
        );
        playLandingFX(root, entry, color, pawnSize, label);
    }, t_land);

    // If a chip is going to mount, cleanup has to wait for it. Without
    // this extension the root was removed at duration+80 while the chip
    // was still doing its opacity-1 hold — the user saw it for ~300ms.
    const chipEndMs = label ? t_land + CHIP_DELAY_MS + CHIP_VISIBLE_MS : 0;
    const cleanupMs = Math.max(duration + CLEANUP_MARGIN_MS, chipEndMs + CLEANUP_MARGIN_MS);

    return scheduleCleanup(root, cleanupMs, onComplete);
}

function playLandingFX(root, entry, color, pawnSize, label) {
    const r = el(
        'plnch-ring',
        'left:' + (entry.x - 6) + 'px;' +
        'top:'  + (entry.y - 6) + 'px;' +
        'width:12px; height:12px;' +
        'color:' + color + ';'
    );
    root.appendChild(r);
    r.animate(
        [
            { opacity: 0,    transform: 'scale(0.4)' },
            { opacity: 0.95, transform: 'scale(1.0)', offset: 0.12 },
            { opacity: 0,    transform: 'scale(6.5)' },
        ],
        { duration: 520, easing: EASE_BURST, fill: 'forwards' }
    );

    const N_DUST = 6;
    for (let i = 0; i < N_DUST; i++) {
        const a = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.6;
        const r1 = pawnSize * (0.5 + Math.random() * 0.5);
        const dx = Math.cos(a) * r1;
        const dy = Math.sin(a) * r1 * 0.6;
        const sz = 6 + Math.random() * 8;
        const d = el(
            'plnch-dust',
            'left:' + (entry.x - sz / 2) + 'px;' +
            'top:'  + (entry.y - sz / 2 + pawnSize * 0.36) + 'px;' +
            'width:' + sz + 'px; height:' + sz + 'px;' +
            'background: rgba(235,227,214,0.55);'
        );
        root.appendChild(d);
        d.animate(
            [
                { opacity: 0,    transform: 'translate(0,0) scale(0.4)' },
                { opacity: 0.85, transform: 'translate(' + (dx * 0.4).toFixed(1) + 'px,' + (dy * 0.4).toFixed(1) + 'px) scale(0.85)', offset: 0.3 },
                { opacity: 0,    transform: 'translate(' + dx.toFixed(1) + 'px,' + dy.toFixed(1) + 'px) scale(1.1)' },
            ],
            { duration: 480, delay: Math.round(Math.random() * 60), easing: 'ease-out', fill: 'forwards' }
        );
    }

    if (label) {
        const labelEl = el(
            'plnch-label',
            'left: 0; right: 0;' +
            'top:' + (entry.y - pawnSize * 1.45) + 'px;' +
            'font-size:' + Math.round(pawnSize * 0.30) + 'px;' +
            'color:' + color + ';' +
            // Push the player color down to the chip background via a
            // custom property — see comment in .plnch-label-chip CSS rule.
            '--plnch-chip-bg:' + color + ';'
        );
        labelEl.innerHTML = '<span class="plnch-label-chip">' + label + '</span>';
        root.appendChild(labelEl);
        // Longer plateau so the player can actually read 'GO!' — old
        // 520ms was so brief the chip flashed and vanished. The wider
        // opacity-1 band (0.18 → 0.88) is what really matters.
        labelEl.animate(
            [
                { opacity: 0, transform: 'translateY(6px) scale(0.7) rotate(-3deg)' },
                { opacity: 1, transform: 'translateY(0)   scale(1.1) rotate(-1deg)', offset: 0.12 },
                { opacity: 1, transform: 'translateY(0)   scale(1)   rotate(0)',     offset: 0.22 },
                { opacity: 1, transform: 'translateY(-2px) scale(1)  rotate(0)',     offset: 0.88 },
                { opacity: 0, transform: 'translateY(-9px) scale(0.95) rotate(0)' },
            ],
            { duration: CHIP_VISIBLE_MS, delay: CHIP_DELAY_MS, easing: 'cubic-bezier(.2,1.6,.3,1)', fill: 'forwards' }
        );
    }
}
