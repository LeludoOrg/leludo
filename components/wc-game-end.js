import {htmlToElement} from "./index.js"
import {playerCaptures, playerNames, playerRanks, playerTimes, playerTypes, playClickSound, dispatch, COMMANDS} from "../scripts/index.js";

const CONFETTI_COLORS = ['var(--base-color-0)', 'var(--base-color-1)', 'var(--base-color-2)', 'var(--base-color-3)'];

function confettiDots() {
    return Array.from({length: 26}).map((_, i) => {
        const x = (i * 37) % 100;
        const y = (i * 53) % 100;
        const w = 4 + (i % 4) * 2;
        const h = 8 + (i % 5);
        const rot = (i * 31) % 360;
        return `<div style="position:absolute;left:${x}%;top:${y}%;width:${w}px;height:${h}px;background:hsl(${CONFETTI_COLORS[i % 4]});border-radius:1px;transform:rotate(${rot}deg);opacity:0.7;"></div>`;
    }).join('');
}

const PAWN_SVG = (playerIndex) => `
    <svg viewBox="0 0 32 32" class="player-fg-${playerIndex}" style="width:160px;height:160px;filter:drop-shadow(0 4px 12px rgba(0,0,0,0.4));">
        <ellipse cx="16" cy="28" rx="8" ry="1.5" fill="rgba(0,0,0,0.25)"/>
        <path d="M16 4c3.2 0 5.5 2.4 5.5 5.2 0 1.8-1 3.2-2.4 4 1.7.7 2.9 1.8 3.6 3.4l1.1 2.6c.4 1 .1 2-.7 2.4-.2.1-.4.1-.6.1H9.5c-.9 0-1.6-.7-1.6-1.6 0-.3.1-.6.2-.9l1.1-2.6c.7-1.6 1.9-2.7 3.6-3.4-1.4-.8-2.4-2.2-2.4-4C10.4 6.4 12.8 4 16 4z" fill="currentColor"/>
        <path d="M16 4c3.2 0 5.5 2.4 5.5 5.2 0 1.8-1 3.2-2.4 4-.6-.3-1.3-.5-2-.5h-2.2c-.7 0-1.4.2-2 .5-1.4-.8-2.4-2.2-2.4-4C10.4 6.4 12.8 4 16 4z" fill="rgba(255,255,255,0.24)"/>
        <rect x="7.5" y="22" width="17" height="3.5" rx="1.4" fill="currentColor"/>
        <rect x="7.5" y="22" width="17" height="1.2" rx="0.6" fill="rgba(255,255,255,0.38)"/>
    </svg>`;

function formatGameTime(ms) {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return minutes > 0 ? `${minutes}m ${remainingSeconds}s` : `${remainingSeconds}s`;
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

async function buildShareImage(winnerIndex, winText, rankArray) {
    const W = 1080, H = 1080;
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#1F1B14';
    ctx.fillRect(0, 0, W, H);

    const confettiHsls = [
        playerHsl(0), playerHsl(1), playerHsl(2), playerHsl(3),
    ];
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
    const pawnSize = 320;
    ctx.drawImage(pawnImg, (W - pawnSize) / 2, 100, pawnSize, pawnSize);

    ctx.fillStyle = '#F2EDE3';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.font = '600 110px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.fillText(winText, W / 2, 530);

    ctx.fillStyle = 'rgba(242,237,227,0.55)';
    ctx.font = '500 30px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.fillText('Final standings', W / 2, 580);

    const cardX = 100, cardY = 620, cardW = W - 200;
    const rowH = 70;
    const cardH = rowH * rankArray.length + 40;

    ctx.fillStyle = 'rgba(242,237,227,0.06)';
    roundRect(ctx, cardX, cardY, cardW, cardH, 28);
    ctx.fill();
    ctx.strokeStyle = 'rgba(242,237,227,0.1)';
    ctx.lineWidth = 2;
    ctx.stroke();

    rankArray.forEach((pi, idx) => {
        const rowY = cardY + 20 + idx * rowH;
        const cy = rowY + rowH / 2;

        if (idx > 0) {
            ctx.strokeStyle = 'rgba(255,255,255,0.08)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(cardX + 24, rowY);
            ctx.lineTo(cardX + cardW - 24, rowY);
            ctx.stroke();
        }

        ctx.fillStyle = 'rgba(255,255,255,0.5)';
        ctx.textAlign = 'left';
        ctx.font = '500 28px ui-monospace, SFMono-Regular, Menlo, monospace';
        ctx.fillText(`${idx + 1}.`, cardX + 28, cy + 10);

        ctx.fillStyle = playerHsl(pi);
        ctx.beginPath();
        ctx.arc(cardX + 90, cy, 14, 0, Math.PI * 2);
        ctx.fill();

        const name = (playerNames[pi] && String(playerNames[pi]).trim()) || (playerTypes[pi] === 'PLAYER' ? 'You' : 'Bot');
        ctx.fillStyle = '#F2EDE3';
        ctx.font = '500 32px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText(name, cardX + 120, cy + 11);

        const time = playerTimes[pi] > 0 ? formatGameTime(playerTimes[pi]) : '—';
        ctx.fillStyle = 'rgba(255,255,255,0.6)';
        ctx.font = '500 28px ui-monospace, SFMono-Regular, Menlo, monospace';
        ctx.textAlign = 'right';
        ctx.fillText(time, cardX + cardW - 28, cy + 10);
    });

    ctx.fillStyle = 'rgba(242,237,227,0.4)';
    ctx.textAlign = 'center';
    ctx.font = '600 26px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.fillText('Leludo', W / 2, H - 60);

    return new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
}

async function shareGameEnd(winnerIndex, winText, rankArray) {
    const shareText = `${winText} Final standings from my Leludo game.`;
    const shareUrl = window.location.origin;
    let blob = null;
    try {
        blob = await buildShareImage(winnerIndex, winText, rankArray);
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
    constructor() {
        super();
    }

    connectedCallback() {
        const rankArray = new Array(4);
        let winnerIndex = 0;
        for (let pi = 0; pi < playerRanks.length; pi++) {
            if (playerRanks[pi] > 0) {
                rankArray[playerRanks[pi] - 1] = pi;
                if (playerRanks[pi] === 1) winnerIndex = pi;
            }
        }

        const isHumanWinner = playerTypes[winnerIndex] === 'PLAYER';
        const winText = isHumanWinner ? 'You won.' : 'Game over.';

        const standingsHTML = rankArray.filter(pi => pi !== undefined).map((pi, idx) => {
            const name = (playerNames[pi] && String(playerNames[pi]).trim()) || (playerTypes[pi] === 'PLAYER' ? 'You' : 'Bot');
            const time = playerTimes[pi] > 0 ? formatGameTime(playerTimes[pi]) : '—';
            return `<div class="standing-row">
                <div class="standing-rank">${idx + 1}.</div>
                <div class="standing-dot player-bg-${pi}"></div>
                <div class="standing-name">${name}</div>
                <div class="standing-time">${time}</div>
            </div>`;
        }).join('');

        const html = `
            <div class="game-end">
                <div class="game-end-inner">
                    <div class="game-end-hero">
                        <div class="game-end-confetti">${confettiDots()}</div>
                        <div class="game-end-pawn">${PAWN_SVG(winnerIndex)}</div>
                        <div class="game-end-title">${winText}</div>
                        <div class="game-end-sub">Final standings</div>
                        <div class="game-end-standings">${standingsHTML}</div>
                    </div>
                    <div class="game-end-actions">
                        <button id="share-btn" class="game-end-btn game-end-btn--share">Share</button>
                        <button id="play-again" class="game-end-btn game-end-btn--again">Play again</button>
                    </div>
                </div>
            </div>`;

        const el = htmlToElement(html);

        const finalRankArray = rankArray.filter(pi => pi !== undefined);

        el.querySelector("#play-again").addEventListener("click", () => {
            playClickSound();
            dispatch({ type: COMMANDS.RESTART_GAME });
        });

        el.querySelector("#share-btn").addEventListener("click", async (ev) => {
            playClickSound();
            const btn = ev.currentTarget;
            if (btn.dataset.busy === '1') return;
            btn.dataset.busy = '1';
            const originalText = btn.textContent;
            btn.textContent = 'Sharing…';
            try {
                await shareGameEnd(winnerIndex, winText, finalRankArray);
            } finally {
                btn.textContent = originalText;
                btn.dataset.busy = '';
            }
        });

        const themeMeta = document.querySelector('meta[name="theme-color"]');
        if (themeMeta) themeMeta.setAttribute('content', '#1F1B14');
        document.body.style.background = '#1F1B14';

        this.appendChild(el);
    }
}

window.customElements.define("wc-game-end", GameEnd);
