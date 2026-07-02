// Launch start-FX burst — halo glow + upward sparks at the launch point.
// Used by playYardLaunch in render-logic.js for yard→entry pawn movement.
// The pawn's travel is the shared pawn-step hop (pawn-step.js).
//
// playLaunchStartFX({
//   container,             HTMLElement (position: relative/absolute)
//   at: {x, y},            REQUIRED. px center of pawn, container-relative
//   color,                 hex fill for halo + sparks. default '#d97644'
//   pawnSize,              px cell size. default 48
// }) → Promise<void>

import {
    el,
    boxAt,
    injectOnce,
    createOverlayRoot,
    scheduleCleanup,
    overlayRootCSS,
    CLEANUP_MARGIN_MS,
} from "./overlay-base.js";

const STYLE_ID = 'plnch-styles';

function injectCSS() {
    injectOnce(STYLE_ID, `
      ${overlayRootCSS('plnch-root')}
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

      .plnch-spark {
        position: absolute;
        border-radius: 999px;
        opacity: 0;
        pointer-events: none;
      }
    `);
}


// Start FX: rising halo glow + a fan of upward sparks at the launch point.
// `at` is the px center of the pawn (container-relative); `fxDur` ms the burst
// runs for. Helper for playLaunchStartFX.
function spawnStartFX(root, at, color, pawnSize, fxDur) {
    // Same feet offset the pawn glyph uses — anchors the FX at the base.
    const baseY = pawnSize * 0.36;

    const haloSize = pawnSize * 1.8;
    const halo = el('plnch-halo', boxAt(at.x, at.y, haloSize, haloSize, baseY) + 'color:' + color + ';');
    root.appendChild(halo);
    halo.animate(
        [
            { opacity: 0,    transform: 'scale(0.4)' },
            { opacity: 0.55, transform: 'scale(0.85)', offset: 0.35 },
            { opacity: 0.85, transform: 'scale(1.0)',  offset: 0.7  },
            { opacity: 0,    transform: 'scale(1.25)' },
        ],
        { duration: fxDur + 60, easing: 'cubic-bezier(.4,.0,.5,1)', fill: 'forwards' }
    );

    const N_SPARK = 8;
    for (let i = 0; i < N_SPARK; i++) {
        const angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 0.9;
        const r0 = pawnSize * 0.45;
        const r1 = pawnSize * (0.9 + Math.random() * 0.6);
        const x0 = at.x + Math.cos(angle) * r0;
        const y0 = at.y + Math.sin(angle) * r0 + baseY;
        const x1 = at.x + Math.cos(angle) * r1;
        const y1 = at.y + Math.sin(angle) * r1 + baseY - pawnSize * 0.3;
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
            { duration: fxDur, delay: Math.round(Math.random() * 120), easing: 'ease-out', fill: 'forwards' }
        );
    }
}

// Standalone burst at the launch point — halo glow + sparks, no pawn, no leap.
// Lets a caller keep the launch's signature start flourish while moving the
// pawn some other way (e.g. the normal cell-to-cell hop). `at` = px pawn center.
const START_FX_MS = 460;
export function playLaunchStartFX({ container, at, color = '#d97644', pawnSize = 48 }) {
    if (!container || !at) throw new Error('playLaunchStartFX: container and at are required');
    injectCSS();
    const root = createOverlayRoot(container, 'plnch-root');
    spawnStartFX(root, at, color, pawnSize, START_FX_MS);
    return scheduleCleanup(root, START_FX_MS + CLEANUP_MARGIN_MS);
}

