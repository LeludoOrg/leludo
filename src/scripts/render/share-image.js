// Off-screen 1080×1080 share-card renderer for the end-of-game recap. Draws the
// winner pawn, the headline and the highlight cards onto a canvas, exports a
// PNG, and hands it to the Web Share API — with a text-share and a download
// fallback. Extracted from components/wc-game-end.js so the recap component is
// just render + wire.

import { miniPawnSVG } from "./pawn-mini.js";
import { isCapacitorNative } from "../platform/platform.js";

function playerHsl(playerIndex) {
    const raw = getComputedStyle(document.documentElement).getPropertyValue(`--player-${playerIndex}`).trim();
    return raw ? `hsl(${raw})` : '#888';
}

function pawnSvgString(playerIndex) {
    const fill = playerHsl(playerIndex);
    return miniPawnSVG({
        fill,
        xmlns: true,
        width: 320,
        height: 320,
        shadow: 0.25,
        highlight: true,
    });
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

function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
            const result = String(reader.result);
            resolve(result.slice(result.indexOf(',') + 1)); // strip "data:...;base64," prefix
        };
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
}

// Capacitor's Android WebView exposes no navigator.share, and an <a download>
// click is a no-op there — the web path below dead-ends inside the APK. Route
// through the Share plugin instead: the OS share sheet needs a file URI (not a
// blob), so write the PNG to the cache dir via Filesystem and hand over the URI.
// Returns true once the native bridge has handled it (even on user-cancel), so
// the caller never falls through to the broken web fallbacks; false only when
// the plugin is absent (un-synced build), letting the web paths still try.
async function shareNative(blob, shareText, shareUrl) {
    const cap = window.Capacitor;
    const Share = cap?.Plugins?.Share;
    if (!Share?.share) {
        console.warn('Capacitor Share plugin missing — install @capacitor/share and re-sync');
        return false;
    }
    const Filesystem = cap?.Plugins?.Filesystem;
    if (blob && Filesystem?.writeFile) {
        try {
            const base64 = await blobToBase64(blob);
            const { uri } = await Filesystem.writeFile({
                path: 'leludo-result.png',
                data: base64,
                directory: 'CACHE', // Directory.Cache — string is the enum value over the bridge
            });
            await Share.share({ title: 'Leludo', text: shareText, files: [uri] });
            return true;
        } catch (e) {
            if (isShareCancel(e)) return true;
            // image share failed (not a cancel) — fall back to text+link below
        }
    }
    try {
        await Share.share({ title: 'Leludo', text: shareText, url: shareUrl });
    } catch (e) {
        // user cancelled or share unavailable; nothing better to fall back to in the WebView
    }
    return true;
}

// The Share plugin rejects with "Share canceled" when the user dismisses the
// sheet — a cancel is a clean exit, not a reason to retry as text-only.
function isShareCancel(e) {
    return /cancel/i.test(e?.message || '');
}

// The recap PNG is the slow part of a share (canvas paint + encode). Build it
// the moment the end screen renders — while the user reads the result — so the
// tap on Share opens the OS sheet instantly instead of stalling on the render.
let _primed = null; // Promise<Blob|null>, resolved/in-flight ahead of the tap

export function primeShareImage(winnerIndex, winText, highlights) {
    _primed = buildShareImage(winnerIndex, winText, highlights).catch(() => null);
    return _primed;
}

export async function shareGameEnd(winnerIndex, winText, highlights) {
    const shareText = `${winText} The recap from my Leludo game.`;
    const shareUrl = window.location.origin;
    let blob = null;
    try {
        // Reuse the image primed at render time; only build now if it wasn't.
        blob = await (_primed || buildShareImage(winnerIndex, winText, highlights));
    } catch (e) {
        // fall through to text-only share
    }
    _primed = null; // consume — the next recap re-primes its own image

    if (isCapacitorNative() && await shareNative(blob, shareText, shareUrl)) return;

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
