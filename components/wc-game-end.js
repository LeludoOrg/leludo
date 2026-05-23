import {htmlToElement} from "./index.js"
import {
    playerCaptures,
    playerNames,
    playerRanks,
    playerTypes,
    sentHomeCount,
    firstHomeStretchTurn,
    firstFinishTurn,
    distanceTraveled,
    pawnsAtBaseAtTurn20,
    bestDiceStreak,
    state,
    selectHighlights,
    playClickSound,
    dispatch,
    COMMANDS,
} from "../scripts/index.js";

const CONFETTI_COLORS = ['var(--base-color-0)', 'var(--base-color-1)', 'var(--base-color-2)', 'var(--base-color-3)'];
const CONFETTI_COUNT = 18;

function confettiPieces() {
    const out = [];
    for (let i = 0; i < CONFETTI_COUNT; i++) {
        const seed = (i * 9301 + 49297) % 233280;
        const r = seed / 233280;
        const r2 = ((seed * 7) % 233280) / 233280;
        const r3 = ((seed * 13) % 233280) / 233280;
        const left = (r * 100).toFixed(2);
        const size = 5 + Math.floor(r2 * 7);
        const color = CONFETTI_COLORS[i % CONFETTI_COLORS.length];
        const delay = -(r * 7).toFixed(2);
        const duration = (5 + r2 * 5).toFixed(2);
        const drift = Math.floor((r3 - 0.5) * 80);
        const rot0 = Math.floor(r * 360);
        const rot1 = Math.floor(540 + r2 * 720);
        const isRect = r > 0.5;
        const w = isRect ? size : size + 2;
        const h = isRect ? Math.round(size * 1.4) : size + 2;
        const radius = isRect ? 1 : 50;
        out.push(`<div class="ge-confetti-piece" style="
            left:${left}%;
            width:${w}px;
            height:${h}px;
            background:hsl(${color});
            border-radius:${radius}${isRect ? 'px' : '%'};
            animation-delay:${delay}s;
            animation-duration:${duration}s;
            --ge-drift:${drift}px;
            --ge-rot0:${rot0}deg;
            --ge-rot1:${rot1}deg;
        "></div>`);
    }
    return out.join('');
}

function pawnSvg(playerIndex, size) {
    return `<svg viewBox="0 0 32 32" class="player-fg-${playerIndex}" style="width:${size}px;height:${size}px;">
        <path d="M16 4c3.2 0 5.5 2.4 5.5 5.2 0 1.8-1 3.2-2.4 4 1.7.7 2.9 1.8 3.6 3.4l1.1 2.6c.4 1 .1 2-.7 2.4-.2.1-.4.1-.6.1H9.5c-.9 0-1.6-.7-1.6-1.6 0-.3.1-.6.2-.9l1.1-2.6c.7-1.6 1.9-2.7 3.6-3.4-1.4-.8-2.4-2.2-2.4-4C10.4 6.4 12.8 4 16 4z" fill="currentColor"/>
        <path d="M16 4c3.2 0 5.5 2.4 5.5 5.2 0 1.8-1 3.2-2.4 4-.6-.3-1.3-.5-2-.5h-2.2c-.7 0-1.4.2-2 .5-1.4-.8-2.4-2.2-2.4-4C10.4 6.4 12.8 4 16 4z" fill="rgba(255,255,255,0.24)"/>
        <rect x="7.5" y="22" width="17" height="3.5" rx="1.4" fill="currentColor"/>
        <rect x="7.5" y="22" width="17" height="1.2" rx="0.6" fill="rgba(255,255,255,0.38)"/>
    </svg>`;
}

const ICON_BACK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M15 6l-6 6 6 6"/></svg>`;
const ICON_SHARE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M12 4v12"/><path d="M7 9l5-5 5 5"/><path d="M5 20h14"/></svg>`;
const CARD_ICONS = {
    ko:   `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" width="14" height="14"><circle cx="12" cy="12" r="7"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3"/></svg>`,
    dice: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><rect x="4" y="4" width="16" height="16" rx="3"/><circle cx="9" cy="9" r="1.3" fill="currentColor"/><circle cx="15" cy="15" r="1.3" fill="currentColor"/><circle cx="15" cy="9" r="1.3" fill="currentColor"/><circle cx="9" cy="15" r="1.3" fill="currentColor"/></svg>`,
    bolt: `<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M13 2L4 14h6l-1 8 9-12h-6l1-8z"/></svg>`,
    send: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M5 12h14"/><path d="M13 6l6 6-6 6"/></svg>`,
    home: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/></svg>`,
    crown:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M3 7l4 5 5-7 5 7 4-5v11H3z"/></svg>`,
};

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function nameFor(pi) {
    const raw = playerNames[pi] && String(playerNames[pi]).trim();
    if (raw) return raw;
    return playerTypes[pi] === 'PLAYER' ? 'You' : 'Bot';
}

function buildSeats() {
    const seats = new Array(4).fill(null);
    for (let i = 0; i < 4; i++) {
        if (!playerTypes[i]) continue;
        seats[i] = { name: nameFor(i), type: playerTypes[i] };
    }
    return seats;
}

function buildStats() {
    return {
        playerCaptures: Array.from(playerCaptures),
        sentHomeCount: Array.from(sentHomeCount),
        bestDiceStreak: Array.from(bestDiceStreak),
        firstFinishTurn: Array.from(firstFinishTurn),
        firstHomeStretchTurn: Array.from(firstHomeStretchTurn),
        distanceTraveled: Array.from(distanceTraveled),
        pawnsAtBaseAtTurn20: Array.from(pawnsAtBaseAtTurn20),
        turnCount: state.turnCount || 0,
    };
}

function playerHsl(playerIndex) {
    const raw = getComputedStyle(document.documentElement).getPropertyValue(`--player-${playerIndex}`).trim();
    return raw ? `hsl(${raw})` : '#888';
}

function pawnSvgString(playerIndex) {
    const fill = playerHsl(playerIndex);
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="320" height="320">
        <ellipse cx="16" cy="28" rx="8" ry="1.5" fill="rgba(0,0,0,0.25)"/>
        <path d="M16 4c3.2 0 5.5 2.4 5.5 5.2 0 1.8-1 3.2-2.4 4 1.7.7 2.9 1.8 3.6 3.4l1.1 2.6c.4 1 .1 2-.7 2.4-.2.1-.4.1-.6.1H9.5c-.9 0-1.6-.7-1.6-1.6 0-.3.1-.6.2-.9l1.1-2.6c.7-1.6 1.9-2.7 3.6-3.4-1.4-.8-2.4-2.2-2.4-4C10.4 6.4 12.8 4 16 4z" fill="${fill}"/>
        <path d="M16 4c3.2 0 5.5 2.4 5.5 5.2 0 1.8-1 3.2-2.4 4-.6-.3-1.3-.5-2-.5h-2.2c-.7 0-1.4.2-2 .5-1.4-.8-2.4-2.2-2.4-4C10.4 6.4 12.8 4 16 4z" fill="rgba(255,255,255,0.24)"/>
        <rect x="7.5" y="22" width="17" height="3.5" rx="1.4" fill="${fill}"/>
        <rect x="7.5" y="22" width="17" height="1.2" rx="0.6" fill="rgba(255,255,255,0.38)"/>
    </svg>`;
}

function loadSvgImage(svgString) {
    return new Promise((resolve, reject) => {
        const blob = new Blob([svgString], { type: 'image/svg+xml' });
        const url = URL.createObjectURL(blob);
        const img = new Image();
        img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
        img.onerror = (e) => { URL.revokeObjectURL(url); reject(e); };
        img.src = url;
    });
}

function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
}

async function buildShareImage(winnerIndex, winText, highlights) {
    const W = 1080, H = 1080;
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#1a1410';
    ctx.fillRect(0, 0, W, H);

    const grad = ctx.createRadialGradient(W / 2, H * 0.3, 0, W / 2, H * 0.3, W * 0.5);
    grad.addColorStop(0, 'rgba(217,118,68,0.22)');
    grad.addColorStop(1, 'rgba(217,118,68,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);

    const confettiHsls = [playerHsl(0), playerHsl(1), playerHsl(2), playerHsl(3)];
    ctx.save();
    ctx.globalAlpha = 0.7;
    for (let i = 0; i < 40; i++) {
        const x = ((i * 37) % 100) / 100 * W;
        const y = ((i * 53) % 100) / 100 * (H * 0.55);
        const w = (4 + (i % 4) * 2) * 2.2;
        const h = (8 + (i % 5)) * 2.2;
        const rot = ((i * 31) % 360) * Math.PI / 180;
        ctx.fillStyle = confettiHsls[i % 4];
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(rot);
        ctx.fillRect(-w / 2, -h / 2, w, h);
        ctx.restore();
    }
    ctx.restore();

    const pawnImg = await loadSvgImage(pawnSvgString(winnerIndex));
    const pawnSize = 240;
    ctx.drawImage(pawnImg, 80, 80, pawnSize, pawnSize);

    ctx.fillStyle = 'rgba(235,227,214,0.55)';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.font = '600 28px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.fillText(winText.toUpperCase(), 340, 170);

    ctx.fillStyle = '#ebe3d6';
    ctx.font = '400 96px "Instrument Serif", Georgia, serif';
    ctx.fillText('The recap.', 340, 280);

    const cardX = 80, cardW = W - 160;
    const cardH = 130;
    const startY = 380;
    const gap = 18;
    highlights.forEach((h, idx) => {
        const y = startY + idx * (cardH + gap);
        const seatColor = playerHsl(h.playerIndex);

        ctx.fillStyle = 'rgba(235,227,214,0.05)';
        roundRect(ctx, cardX, y, cardW, cardH, 24);
        ctx.fill();
        ctx.strokeStyle = 'rgba(235,227,214,0.1)';
        ctx.lineWidth = 2;
        ctx.stroke();

        ctx.fillStyle = seatColor;
        roundRect(ctx, cardX, y, 8, cardH, 4);
        ctx.fill();

        ctx.fillStyle = '#ebe3d6';
        ctx.textAlign = 'left';
        ctx.font = '600 32px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
        ctx.fillText(h.title, cardX + 50, y + 50);

        ctx.fillStyle = 'rgba(235,227,214,0.62)';
        ctx.font = '400 26px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
        ctx.fillText(h.body, cardX + 50, y + 90);

        ctx.fillStyle = '#ebe3d6';
        ctx.font = '400 56px "Instrument Serif", Georgia, serif';
        ctx.textAlign = 'right';
        ctx.fillText(h.stat, cardX + cardW - 30, y + 80);
    });

    ctx.fillStyle = 'rgba(235,227,214,0.4)';
    ctx.textAlign = 'center';
    ctx.font = '600 26px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.fillText('Leludo', W / 2, H - 60);

    return new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
}

async function shareGameEnd(winnerIndex, winText, highlights) {
    const shareText = `${winText} The recap from my Leludo game.`;
    const shareUrl = window.location.origin;
    let blob = null;
    try {
        blob = await buildShareImage(winnerIndex, winText, highlights);
    } catch (e) {
        // fall through to text-only share
    }

    if (blob && navigator.canShare) {
        const file = new File([blob], 'leludo-result.png', { type: 'image/png' });
        if (navigator.canShare({ files: [file] })) {
            try {
                await navigator.share({ files: [file], title: 'Leludo', text: shareText });
                return;
            } catch (e) {
                if (e && e.name === 'AbortError') return;
            }
        }
    }

    if (navigator.share) {
        try {
            await navigator.share({ title: 'Leludo', text: shareText, url: shareUrl });
            return;
        } catch (e) {
            if (e && e.name === 'AbortError') return;
        }
    }

    if (blob) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'leludo-result.png';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
}

class GameEnd extends HTMLElement {
    connectedCallback() {
        let winnerIndex = 0;
        for (let pi = 0; pi < playerRanks.length; pi++) {
            if (playerRanks[pi] === 1) { winnerIndex = pi; break; }
        }

        const isHumanWinner = playerTypes[winnerIndex] === 'PLAYER';
        const winnerName = nameFor(winnerIndex);
        const eyebrow = isHumanWinner
            ? 'Game over · You won'
            : `Game over · ${winnerName} won`;
        const winText = isHumanWinner ? 'You won.' : `${winnerName} won.`;

        const seats = buildSeats();
        const stats = buildStats();
        const highlights = selectHighlights({ stats, seats, winnerIndex });

        const cardsHTML = highlights.map(h => `
            <div class="ge-card player-border-${h.playerIndex}">
                <div class="ge-card-icon player-fg-${h.playerIndex}"
                     style="background-color: hsl(var(--player-${h.playerIndex}) / 0.13);">
                    ${CARD_ICONS[h.type] || CARD_ICONS.crown}
                </div>
                <div class="ge-card-text">
                    <div class="ge-card-title">${escapeHtml(h.title)}</div>
                    <div class="ge-card-body">${escapeHtml(h.body)}</div>
                </div>
                <div class="ge-card-stat">${escapeHtml(h.stat)}</div>
            </div>`).join('');

        const html = `
            <div class="ge-screen">
                <div class="ge-glow"></div>
                <div class="ge-confetti">${confettiPieces()}</div>

                <div class="ge-inner">
                    <div class="ge-header">
                        <button id="ge-home" class="ge-home-pill" aria-label="Home">
                            ${ICON_BACK} Home
                        </button>
                        <button id="ge-share" class="ge-icon-btn" aria-label="Share">
                            ${ICON_SHARE}
                        </button>
                    </div>

                    <div class="ge-hero">
                        <div class="ge-hero-pawn">
                            <div class="ge-pawn-shadow"></div>
                            <div class="ge-pawn-bob">${pawnSvg(winnerIndex, 78)}</div>
                        </div>
                        <div class="ge-hero-text">
                            <div class="ge-eyebrow">${escapeHtml(eyebrow)}</div>
                            <div class="ge-headline">The recap.</div>
                        </div>
                    </div>

                    <div class="ge-cards">${cardsHTML}</div>

                    <div class="ge-spacer"></div>

                    <div class="ge-footer">
                        <button id="ge-play-again" class="ge-cta">Play again</button>
                    </div>
                </div>
            </div>`;

        const el = htmlToElement(html);

        el.querySelector('#ge-home').addEventListener('click', () => {
            playClickSound();
            dispatch({ type: COMMANDS.EXIT_TO_HOME });
        });

        el.querySelector('#ge-play-again').addEventListener('click', () => {
            playClickSound();
            dispatch({ type: COMMANDS.RESTART_GAME });
        });

        el.querySelector('#ge-share').addEventListener('click', async (ev) => {
            playClickSound();
            const btn = ev.currentTarget;
            if (btn.dataset.busy === '1') return;
            btn.dataset.busy = '1';
            btn.classList.add('ge-busy');
            try {
                await shareGameEnd(winnerIndex, winText, highlights);
            } finally {
                btn.dataset.busy = '';
                btn.classList.remove('ge-busy');
            }
        });

        const themeMeta = document.querySelector('meta[name="theme-color"]');
        if (themeMeta) {
            this._prevThemeColor = themeMeta.getAttribute('content');
            themeMeta.setAttribute(
                'content',
                document.documentElement.classList.contains('dark') ? '#1a1410' : '#ede4d3',
            );
        }

        this.appendChild(el);
    }
}

window.customElements.define('wc-game-end', GameEnd);
