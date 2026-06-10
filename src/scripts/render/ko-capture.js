// KO Punch capture overlay. Self-contained DOM/style; shares the pawn shape
// (pawn-shape.js) and overlay scaffolding (overlay-base.js) with the sibling
// launch / home-arrival overlays.
//
// playKOCapture({
//   container,              HTMLElement (position: relative/absolute)
//   capture: {x, y},        px from container top-left, center of capture cell
//   homeBase: {x, y},       px from container top-left, defender home target
//   attackerColor,          any CSS color string — POW! fill + trailing stars
//   defenderColor,          any CSS color string — flying pawn fill
//   attackFrom,             'left' | 'right' | 'top' | 'bottom'
//   pawnSize,               px (height of flying pawn) — ~1.4× cell size
//   duration,               total ms (default 1100)
//   shakeBoard,             bool — applies brief shake to container
//   onComplete,             optional callback fired after cleanup
// }) → Promise<void>  (resolves after overlay DOM is removed)

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
} from "./overlay-base.js";

const STYLE_ID = 'kocap-styles';

function injectCSS() {
    injectOnce(STYLE_ID, `
      ${overlayRootCSS('kocap-root')}
      .kocap-layer { position: absolute; left: 0; top: 0; }
      /* Outer wrap owns translate + spin + the start→end size scale; origin
         center keeps the pawn centered on its target as it scales, so its
         final frame lands exactly on the real token's box. */
      .kocap-pawn-wrap { position: absolute; transform-origin: center center; }
      /* Inner element owns the punch squash; origin at the feet (token base
         sits at y=88/100 in the square viewBox). */
      .kocap-pawn-squash { transform-origin: center 86%; }
      .kocap-pawn-svg { display: block; filter: drop-shadow(0 4px 8px rgba(0,0,0,0.45)); }

      .kocap-pow { position: absolute; transform-origin: center; }
      .kocap-pow svg { display: block; width: 100%; height: 100%; overflow: visible; }
      .kocap-pow text {
        font-family: 'JetBrains Mono', ui-monospace, monospace;
        font-weight: 800; letter-spacing: 1.5px;
        text-anchor: middle; dominant-baseline: central;
        fill: #fff;
        paint-order: stroke;
        stroke: rgba(0,0,0,0.35);
        stroke-width: 0.8;
      }

      .kocap-speed-line {
        position: absolute;
        height: 2px;
        background: rgba(235,227,214,0.9);
        border-radius: 2px;
        opacity: 0;
      }

      .kocap-star {
        position: absolute;
        width: 10px; height: 10px;
        clip-path: polygon(50% 0%, 61% 35%, 98% 35%, 68% 57%, 79% 91%, 50% 70%, 21% 91%, 32% 57%, 2% 35%, 39% 35%);
        opacity: 0;
      }

      @keyframes kocap-shake {
        0%, 100% { transform: translate(0, 0); }
        10% { transform: translate(-3px, 2px); }
        20% { transform: translate(3px, -2px); }
        30% { transform: translate(-2px, 1px); }
        40% { transform: translate(2px, -1px); }
        50% { transform: translate(-1px, 1px); }
        60% { transform: translate(1px, 0); }
      }
      .kocap-board-shake { animation: kocap-shake 320ms ease-out; }
    `);
}

function powSVG(attackerColor) {
    return (
        '<svg viewBox="0 0 120 120">' +
        '<polygon ' +
        'points="60,4 70,28 95,18 88,44 116,50 92,64 110,86 84,82 88,110 65,94 60,116 55,94 32,110 36,82 10,86 28,64 4,50 32,44 25,18 50,28" ' +
        'fill="' + attackerColor + '" stroke="#ebe3d6" stroke-width="2.5" stroke-linejoin="round" />' +
        '<text x="60" y="62" font-size="22" transform="rotate(-8 60 62)">POW!</text>' +
        '</svg>'
    );
}

function arcKeyframes(dx, dy, spins, endScale) {
    const N = 28;
    const peak = Math.max(120, Math.abs(dx) * 0.5, Math.abs(dy) * 0.4);
    const frames = [];
    for (let i = 0; i <= N; i++) {
        const t = i / N;
        const { x, y } = arcPoint({ x: 0, y: 0 }, { x: dx, y: dy }, t, peak);
        const rot = spins * 360 * t;
        // Scale from the on-board size to the home-seat size so the final
        // frame matches the real token exactly.
        const s = 1 + (endScale - 1) * t;
        // No opacity fade: the pawn must fly all the way onto its home seat
        // and stay solid until the overlay hands off to the real token.
        // Fading it out mid-air made the pawn vanish, then pop back in at
        // home — a visible gap. Landing solid reads as one continuous throw.
        frames.push({
            transform: 'translate(' + x.toFixed(1) + 'px, ' + y.toFixed(1) + 'px) rotate(' + rot.toFixed(0) + 'deg) scale(' + s.toFixed(3) + ')',
            offset: t,
        });
    }
    return frames;
}

export function playKOCapture(opts) {
    if (!opts || !opts.container || !opts.capture) {
        throw new Error('playKOCapture: container and capture are required');
    }
    injectCSS();

    const container = opts.container;
    const cap = opts.capture;
    const attackerColor = opts.attackerColor || '#cf4a3a';
    const defenderColor = opts.defenderColor || '#2f9456';
    const pawnSize = opts.pawnSize || 48;
    // Final size relative to the start size. Home seats are ~one cell but not
    // pixel-identical to a path cell, so the pawn scales to the real token's
    // exact resting footprint as it lands. 1 = no size change.
    const endScale = opts.endScale != null ? opts.endScale : 1;
    const duration = opts.duration || 1100;
    const attackFrom = opts.attackFrom || 'left';
    const shakeBoard = opts.shakeBoard !== false;
    const onComplete = opts.onComplete || function () {};

    // Default homeBase = ballistic throw opposite of attack direction.
    const dirVec = ({
        left:   { x:  1, y: -1 },
        right:  { x: -1, y: -1 },
        top:    { x:  1, y:  1 },
        bottom: { x:  1, y: -1 },
    })[attackFrom] || { x: 1, y: -1 };
    const home = opts.homeBase || {
        x: cap.x + dirVec.x * 320,
        y: cap.y + dirVec.y * 240,
    };

    const root = createOverlayRoot(container, 'kocap-root');

    const powSize = pawnSize * 2.2;
    const pow = el('kocap-pow',
        'left:' + (cap.x - powSize / 2) + 'px;' +
        'top:'  + (cap.y - powSize / 2) + 'px;' +
        'width:'  + powSize + 'px;' +
        'height:' + powSize + 'px;');
    pow.innerHTML = powSVG(attackerColor);
    root.appendChild(pow);

    pow.animate(
        [
            { opacity: 0, transform: 'scale(0.2) rotate(-15deg)', offset: 0 },
            { opacity: 1, transform: 'scale(1.18) rotate(-5deg)', offset: 0.18 },
            { opacity: 1, transform: 'scale(1.00) rotate(2deg)',  offset: 0.45 },
            { opacity: 1, transform: 'scale(1.00) rotate(2deg)',  offset: 0.75 },
            { opacity: 0, transform: 'scale(0.95) rotate(2deg)',  offset: 1 },
        ],
        { duration: Math.round(duration * 0.7), easing: 'cubic-bezier(.2,1.5,.3,1)', fill: 'forwards' }
    );

    const lineAngle = ({ left: 0, right: 180, top: 90, bottom: 270 })[attackFrom] || 0;
    for (let i = 0; i < 4; i++) {
        const len = 30 + Math.random() * 30;
        const offset = -30 + i * 18;
        const line = el('kocap-speed-line',
            'left:' + (cap.x + 18) + 'px;' +
            'top:'  + (cap.y + offset) + 'px;' +
            'width:' + len + 'px;' +
            'transform-origin: 0 50%;' +
            'transform: rotate(' + lineAngle + 'deg);');
        root.appendChild(line);
        line.animate(
            [
                { opacity: 0, transform: 'rotate(' + lineAngle + 'deg) translateX(-30px)' },
                { opacity: 1, transform: 'rotate(' + lineAngle + 'deg) translateX(0)', offset: 0.4 },
                { opacity: 0, transform: 'rotate(' + lineAngle + 'deg) translateX(60px)' },
            ],
            { duration: Math.round(duration * 0.45), delay: i * 40, fill: 'forwards' }
        );
    }

    const traj = el('kocap-pawn-wrap',
        'left:' + (cap.x - pawnSize / 2) + 'px;' +
        'top:'  + (cap.y - pawnSize / 2) + 'px;' +
        'width:' + pawnSize + 'px;' +
        'height:' + pawnSize + 'px;');

    const squash = el('kocap-pawn-squash');
    squash.innerHTML = pawnSVG(defenderColor, pawnSize, 'kocap-pawn-svg', 'kocap-grad-');
    traj.appendChild(squash);
    root.appendChild(traj);

    squash.animate(
        [
            { transform: 'scale(1, 1)',      offset: 0 },
            { transform: 'scale(1.25, 0.7)', offset: 0.08 },
            { transform: 'scale(0.9, 1.1)',  offset: 0.18 },
            { transform: 'scale(1, 1)',      offset: 0.3 },
            { transform: 'scale(1, 1)',      offset: 1 },
        ],
        { duration: duration, easing: EASE_SETTLE, fill: 'forwards' }
    );

    const dx = home.x - cap.x;
    const dy = home.y - cap.y;
    traj.animate(arcKeyframes(dx, dy, dy < 0 ? 2 : -2, endScale), {
        duration: duration,
        easing: 'cubic-bezier(.4, 0, .3, 1)',
        fill: 'forwards',
    });

    const starOffsets = [
        { x:  60, y:  -90, d:  60 },
        { x:  90, y:  -60, d:  90 },
        { x:  40, y: -120, d: 120 },
    ];
    starOffsets.forEach(function (o) {
        const star = el('kocap-star',
            'left:' + (cap.x - 5) + 'px;' +
            'top:'  + (cap.y - 5) + 'px;' +
            'background:' + attackerColor + ';');
        root.appendChild(star);
        const sx = ({ left: 1, right: -1, top: 1, bottom: 1 }[attackFrom] || 1) * o.x;
        const sy = ({ top: 1, bottom: -1, left: 1, right: 1 }[attackFrom] || 1) * o.y;
        star.animate(
            [
                { opacity: 0, transform: 'translate(0,0) scale(0.4) rotate(0)', offset: 0 },
                { opacity: 1, transform: 'translate(' + (sx * 0.4) + 'px,' + (sy * 0.4) + 'px) scale(1) rotate(120deg)', offset: 0.4 },
                { opacity: 0, transform: 'translate(' + sx + 'px,' + sy + 'px) scale(0.6) rotate(360deg)', offset: 1 },
            ],
            { duration: Math.round(duration * 0.55), delay: o.d, fill: 'forwards' }
        );
    });

    if (shakeBoard) {
        container.classList.remove('kocap-board-shake');
        void container.offsetWidth;
        container.classList.add('kocap-board-shake');
        setTimeout(function () { container.classList.remove('kocap-board-shake'); }, 360);
    }

    return scheduleCleanup(root, duration + CLEANUP_MARGIN_MS, onComplete);
}
