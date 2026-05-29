// Home Arrival overlay. Standalone — no deps. Self-contained DOM/style.
// Pawn slides from approach cell into finish slot, settles with a bounce,
// then confetti burst + 'HOME!' chip plays on top.
//
// playHomeArrival({
//   container,             HTMLElement (position: relative/absolute)
//   home: {x, y},          REQUIRED. px center of finish slot, relative to container
//   source: {x, y} | null, optional — pawn slides source→home (with hop) first
//   color,                 hex — pawn fill + confetti accent + chip + flash tint
//   pawnSize,              px height of pawn (~1.2–1.5× cell size). default 48
//   duration,              total ms. default 1400
//   flashBoard,            bool — tinted full-bleed pulse (mix-blend-mode: screen)
//   label,                 string on the chip. default 'HOME!'
//   onComplete,            optional callback fired after cleanup
// }) → Promise<void>

const STYLE_ID = 'hmarr-styles';

function injectCSS() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      .hmarr-root {
        position: absolute; inset: 0;
        pointer-events: none;
        z-index: 1000;
        overflow: visible;
      }
      /* Outer wrap owns translate + the start→end size scale; origin
         center keeps the pawn centered on its slot as it shrinks. */
      .hmarr-pawn-wrap { position: absolute; transform-origin: center center; }
      /* Inner element owns the settle squash; origin at the feet (the token
         base sits at y=88/100 in the square viewBox). */
      .hmarr-pawn-squash { transform-origin: center 86%; }
      .hmarr-pawn-svg  { display: block; filter: drop-shadow(0 4px 10px rgba(0,0,0,0.45)); }

      .hmarr-ring {
        position: absolute;
        border-radius: 50%;
        border: 3px solid currentColor;
        opacity: 0;
        pointer-events: none;
      }

      .hmarr-confetti {
        position: absolute;
        width: 8px; height: 12px;
        border-radius: 1px;
        opacity: 0;
        transform-origin: center;
      }

      .hmarr-label {
        position: absolute;
        font-family: 'JetBrains Mono', ui-monospace, monospace;
        font-weight: 800; letter-spacing: 2px;
        text-align: center;
        opacity: 0;
        transform-origin: center;
        white-space: nowrap;
        pointer-events: none;
      }
      .hmarr-label .hmarr-label-chip {
        display: inline-block;
        padding: 7px 16px;
        border-radius: 999px;
        background: currentColor;
        color: #1a1410;
        box-shadow: 0 6px 18px rgba(0,0,0,0.35);
      }

      .hmarr-flash {
        position: absolute; inset: 0;
        background: currentColor;
        opacity: 0;
        border-radius: inherit;
        pointer-events: none;
        mix-blend-mode: screen;
      }
    `;
    document.head.appendChild(style);
}

// Body + head path copied verbatim from components/wc-token.js so the
// arriving pawn is the SAME shape as the real game token. Square
// 0 0 100 100 viewBox (token aspect); the wrap is sized square too.
const PAWN_BODY = 'M32 85 Q30 70 36 55 Q40 45 42 38 L58 38 Q60 45 64 55 Q70 70 68 85 Z';
let _gradUid = 0;

function pawnSVG(color, size) {
    const uid = 'hmarr-grad-' + (++_gradUid);
    return (
        '<svg class="hmarr-pawn-svg" viewBox="0 0 100 100" ' +
        'width="' + size + '" height="' + size + '">' +
        '<defs>' +
            '<linearGradient id="' + uid + 'b" x1="0.2" y1="0" x2="0.8" y2="1">' +
                '<stop offset="0%" stop-color="white" stop-opacity="0.35"/>' +
                '<stop offset="100%" stop-color="black" stop-opacity="0.12"/>' +
            '</linearGradient>' +
            '<radialGradient id="' + uid + 'h" cx="0.4" cy="0.35" r="0.5">' +
                '<stop offset="0%" stop-color="white" stop-opacity="0.45"/>' +
                '<stop offset="100%" stop-color="white" stop-opacity="0"/>' +
            '</radialGradient>' +
        '</defs>' +
        '<ellipse cx="50" cy="88" rx="30" ry="8" fill="' + color + '"/>' +
        '<ellipse cx="50" cy="88" rx="30" ry="8" fill="black" opacity="0.1"/>' +
        '<path d="' + PAWN_BODY + '" fill="' + color + '" stroke="white" stroke-width="1.5" stroke-opacity="0.5"/>' +
        '<path d="' + PAWN_BODY + '" fill="url(#' + uid + 'b)"/>' +
        '<ellipse cx="50" cy="38" rx="13" ry="4" fill="' + color + '"/>' +
        '<ellipse cx="50" cy="38" rx="13" ry="4" fill="white" opacity="0.15"/>' +
        '<circle cx="50" cy="24" r="16" fill="' + color + '" stroke="white" stroke-width="1.5" stroke-opacity="0.5"/>' +
        '<circle cx="50" cy="24" r="16" fill="url(#' + uid + 'h)"/>' +
        '<ellipse cx="44" cy="18" rx="5" ry="3.5" fill="white" opacity="0.4" transform="rotate(-20 44 18)"/>' +
        '</svg>'
    );
}

function el(cls, css) {
    const d = document.createElement('div');
    d.className = cls;
    if (css) d.style.cssText = css;
    return d;
}

export function playHomeArrival(opts) {
    if (!opts || !opts.container || !opts.home) {
        throw new Error('playHomeArrival: container and home are required');
    }
    injectCSS();

    const container  = opts.container;
    const home       = opts.home;
    const source     = opts.source || null;
    const color      = opts.color || '#d97644';
    const pawnSize   = opts.pawnSize || 48;
    // Celebration radius for the confetti/ring/label. Decoupled from pawnSize
    // because the arriving pawn shrinks to the tiny finish slot — scaling the
    // burst off that size collapsed the confetti into a small cluster. Pass a
    // generous value so the confetti actually flies out across the board.
    const burstSize  = opts.burstSize || pawnSize;
    const duration   = opts.duration || 1400;
    const flashBoard = opts.flashBoard === true;
    const label      = opts.label || 'HOME!';
    const onComplete = opts.onComplete || function () {};
    // Final size relative to the start size. Finish slots stack tokens far
    // smaller than a cell, so the pawn must shrink as it lands to match the
    // real settled token's size. 1 = no size change.
    const endScale   = opts.endScale != null ? opts.endScale : 1;

    const root = el('hmarr-root');
    container.appendChild(root);

    const startX = source ? source.x : home.x;
    const startY = source ? source.y : home.y;
    // Outer wrap: square, sized to the START token, centered on its center.
    const traj = el(
        'hmarr-pawn-wrap',
        'left:' + (startX - pawnSize / 2) + 'px;' +
        'top:'  + (startY - pawnSize / 2) + 'px;' +
        'width:' + pawnSize + 'px;' +
        'height:' + pawnSize + 'px;'
    );
    // Inner element carries the SVG + the settle squash, layered on top of
    // the outer translate/scale.
    const squash = el('hmarr-pawn-squash');
    squash.innerHTML = pawnSVG(color, pawnSize);
    traj.appendChild(squash);
    root.appendChild(traj);

    const travelMs = source ? Math.round(duration * 0.4) : 0;
    const dx = home.x - startX;
    const dy = home.y - startY;
    const midScale = 1 + (endScale - 1) * 0.5;

    if (source) {
        traj.animate(
            [
                { transform: 'translate(0,0) scale(1)' },
                { transform: 'translate(' + (dx * 0.5).toFixed(1) + 'px,' + (dy * 0.5 - 18).toFixed(1) + 'px) scale(' + midScale.toFixed(3) + ')', offset: 0.5 },
                { transform: 'translate(' + dx.toFixed(1) + 'px,' + dy.toFixed(1) + 'px) scale(' + endScale.toFixed(3) + ')' },
            ],
            { duration: travelMs, easing: 'cubic-bezier(.4, 0, .25, 1)', fill: 'forwards' }
        );
    } else {
        // No travel: settle straight into the (already-scaled) finish slot.
        traj.style.transform = 'translate(' + dx.toFixed(1) + 'px,' + dy.toFixed(1) + 'px) scale(' + endScale.toFixed(3) + ')';
    }

    setTimeout(function () {
        squash.animate(
            [
                { transform: 'scale(1, 1)' },
                { transform: 'scale(1.08, 0.86)', offset: 0.25 },
                { transform: 'scale(0.94, 1.08)', offset: 0.55 },
                { transform: 'scale(1, 1)' },
            ],
            { duration: 480, easing: 'cubic-bezier(.3, 1.6, .4, 1)', fill: 'forwards' }
        );
    }, travelMs);

    setTimeout(function () {
        playBurst(root, home, color, label, duration - travelMs, burstSize);
        if (flashBoard) playBoardFlash(root, color);
    }, travelMs);

    return new Promise(function (resolve) {
        setTimeout(function () {
            if (root.parentNode) root.parentNode.removeChild(root);
            onComplete();
            resolve();
        }, duration + 80);
    });
}

function playBurst(root, home, color, label, ms, burstSize) {
    const r = el(
        'hmarr-ring',
        'left:' + (home.x - 6) + 'px;' +
        'top:'  + (home.y - 6) + 'px;' +
        'width:12px;height:12px;' +
        'color:' + color + ';'
    );
    root.appendChild(r);
    r.animate(
        [
            { opacity: 0,   transform: 'scale(0.4)' },
            { opacity: 0.9, transform: 'scale(1.0)', offset: 0.08 },
            { opacity: 0,   transform: 'scale(8)' },
        ],
        { duration: Math.round(ms * 0.5), easing: 'cubic-bezier(.2,.7,.3,1)', fill: 'forwards' }
    );

    const palette = [color, color, color, '#ebe3d6', '#1a1410', '#f3c969'];
    const N = 32;
    for (let i = 0; i < N; i++) {
        // Full upward fan so confetti flies out across the board instead of
        // bunching into a tight cluster near the finish slot.
        const a = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.4;
        const speed = burstSize * (1.4 + Math.random() * 1.4);
        const tx = Math.cos(a) * speed;
        const ty = Math.sin(a) * speed * 0.9 + burstSize * 0.4;
        const w = burstSize * 0.1 + Math.random() * burstSize * 0.1;
        const h = burstSize * 0.16 + Math.random() * burstSize * 0.14;
        const rot = (Math.random() - 0.5) * 720;
        const c = palette[i % palette.length];
        const conf = el(
            'hmarr-confetti',
            'left:' + (home.x - w / 2) + 'px;' +
            'top:'  + (home.y - h / 2) + 'px;' +
            'width:' + w + 'px; height:' + h + 'px;' +
            'background:' + c + ';'
        );
        root.appendChild(conf);
        conf.animate(
            [
                { opacity: 0, transform: 'translate(0,0) rotate(0)' },
                { opacity: 1, transform: 'translate(' + (tx * 0.5).toFixed(1) + 'px,' + (ty * 0.4 - 18).toFixed(1) + 'px) rotate(' + (rot * 0.5).toFixed(0) + 'deg)', offset: 0.3 },
                { opacity: 1, transform: 'translate(' + tx.toFixed(1) + 'px,' + ty.toFixed(1) + 'px) rotate(' + rot.toFixed(0) + 'deg)', offset: 0.85 },
                { opacity: 0, transform: 'translate(' + (tx * 1.05).toFixed(1) + 'px,' + (ty + 18).toFixed(1) + 'px) rotate(' + (rot * 1.1).toFixed(0) + 'deg)' },
            ],
            { duration: Math.round(ms * 0.85), delay: Math.round(Math.random() * 120), easing: 'cubic-bezier(.2,.7,.3,1)', fill: 'forwards' }
        );
    }

    const labelEl = el(
        'hmarr-label',
        'left: 0; right: 0;' +
        'top:' + (home.y - burstSize * 0.9) + 'px;' +
        'font-size:' + Math.round(burstSize * 0.22) + 'px;' +
        'color:' + color + ';'
    );
    labelEl.innerHTML = '<span class="hmarr-label-chip">' + label + '</span>';
    root.appendChild(labelEl);
    labelEl.animate(
        [
            { opacity: 0, transform: 'translateY(8px) scale(0.6) rotate(-4deg)' },
            { opacity: 1, transform: 'translateY(0) scale(1.1) rotate(-2deg)', offset: 0.25 },
            { opacity: 1, transform: 'translateY(0) scale(1)   rotate(0)',     offset: 0.4 },
            { opacity: 1, transform: 'translateY(-2px) scale(1) rotate(0)',    offset: 0.85 },
            { opacity: 0, transform: 'translateY(-10px) scale(0.95) rotate(0)' },
        ],
        { duration: Math.round(ms * 0.9), delay: 80, easing: 'cubic-bezier(.2,1.6,.3,1)', fill: 'forwards' }
    );
}

function playBoardFlash(root, color) {
    const flash = el('hmarr-flash', 'color:' + color + ';');
    root.appendChild(flash);
    flash.animate(
        [
            { opacity: 0 },
            { opacity: 0.55, offset: 0.12 },
            { opacity: 0.35, offset: 0.4 },
            { opacity: 0 },
        ],
        { duration: 520, easing: 'cubic-bezier(.2,.7,.3,1)', fill: 'forwards' }
    );
}
