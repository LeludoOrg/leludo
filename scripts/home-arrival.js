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
      .hmarr-pawn-wrap { position: absolute; transform-origin: center 80%; }
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

function pawnSVG(color, size) {
    const w = size * 0.75;
    return (
        '<svg class="hmarr-pawn-svg" viewBox="0 0 60 80" ' +
        'width="' + w + '" height="' + size + '">' +
        '<ellipse cx="30" cy="74" rx="17" ry="3" fill="rgba(0,0,0,0.55)" />' +
        '<path fill="' + color + '" d="M 30 6 C 38 6, 42 13, 38 19 ' +
        'C 40 21, 40 23, 36.5 24 C 39.5 27, 39.5 31, 35.5 32.5 ' +
        'L 44 36 L 50 70 L 10 70 L 16 36 L 24.5 32.5 ' +
        'C 20.5 31, 20.5 27, 23.5 24 C 20 23, 20 21, 22 19 ' +
        'C 18 13, 22 6, 30 6 Z" />' +
        '<ellipse cx="25" cy="13" rx="2.6" ry="3.6" fill="rgba(255,255,255,0.28)" />' +
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
    const duration   = opts.duration || 1400;
    const flashBoard = opts.flashBoard === true;
    const label      = opts.label || 'HOME!';
    const onComplete = opts.onComplete || function () {};

    const root = el('hmarr-root');
    container.appendChild(root);

    const pawnW = pawnSize * 0.75;
    const startX = source ? source.x : home.x;
    const startY = source ? source.y : home.y;
    const traj = el(
        'hmarr-pawn-wrap',
        'left:' + (startX - pawnW / 2) + 'px;' +
        'top:'  + (startY - pawnSize * 0.72) + 'px;' +
        'width:' + pawnW + 'px;' +
        'height:' + pawnSize + 'px;'
    );
    traj.innerHTML = pawnSVG(color, pawnSize);
    root.appendChild(traj);

    const travelMs = source ? Math.round(duration * 0.4) : 0;
    const dx = home.x - startX;
    const dy = home.y - startY;

    if (source) {
        traj.animate(
            [
                { transform: 'translate(0,0)' },
                { transform: 'translate(' + (dx * 0.5).toFixed(1) + 'px,' + (dy * 0.5 - 18).toFixed(1) + 'px)', offset: 0.5 },
                { transform: 'translate(' + dx.toFixed(1) + 'px,' + dy.toFixed(1) + 'px)' },
            ],
            { duration: travelMs, easing: 'cubic-bezier(.4, 0, .25, 1)', fill: 'forwards' }
        );
    }

    setTimeout(function () {
        traj.animate(
            [
                { transform: 'translate(' + dx.toFixed(1) + 'px,' + dy.toFixed(1) + 'px) scale(1, 1)' },
                { transform: 'translate(' + dx.toFixed(1) + 'px,' + (dy + 4).toFixed(1) + 'px) scale(1.08, 0.86)', offset: 0.25 },
                { transform: 'translate(' + dx.toFixed(1) + 'px,' + (dy - 6).toFixed(1) + 'px) scale(0.94, 1.08)', offset: 0.55 },
                { transform: 'translate(' + dx.toFixed(1) + 'px,' + dy.toFixed(1) + 'px) scale(1, 1)' },
            ],
            { duration: 480, easing: 'cubic-bezier(.3, 1.6, .4, 1)', fill: 'forwards' }
        );
    }, travelMs);

    setTimeout(function () {
        playBurst(root, home, color, label, duration - travelMs, pawnSize);
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

function playBurst(root, home, color, label, ms, pawnSize) {
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
    const N = 24;
    for (let i = 0; i < N; i++) {
        const a = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.1;
        const speed = pawnSize * (1.4 + Math.random() * 1.4);
        const tx = Math.cos(a) * speed;
        const ty = Math.sin(a) * speed * 0.9 + pawnSize * 0.4;
        const w = 5 + Math.random() * 6;
        const h = 8 + Math.random() * 8;
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
        'top:' + (home.y - pawnSize * 1.5) + 'px;' +
        'font-size:' + Math.round(pawnSize * 0.32) + 'px;' +
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
