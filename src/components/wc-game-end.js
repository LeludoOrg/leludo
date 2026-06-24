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
    selectHighlightsBySeat,
    playClickSound,
    dispatch,
    COMMANDS,
    escapeHtml,
    shouldShowStoreNudge,
    isCapacitorNative,
    openPlayStore,
} from "../scripts/index.js";
import {trackEvent} from "../scripts/platform/analytics.js";
import {isOnlineActive, onlineLocalSelf, toServer} from "../scripts/net/online-state.js";
import {MINI_PAWN_BODY, MINI_PAWN_HIGHLIGHT} from "../scripts/render/pawn-mini.js";
import {shareGameEnd, primeShareImage} from "../scripts/render/share-image.js";

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
        <path d="${MINI_PAWN_BODY}" fill="currentColor"/>
        <path d="${MINI_PAWN_HIGHLIGHT}" fill="rgba(255,255,255,0.24)"/>
        <rect x="7.5" y="22" width="17" height="3.5" rx="1.4" fill="currentColor"/>
        <rect x="7.5" y="22" width="17" height="1.2" rx="0.6" fill="rgba(255,255,255,0.38)"/>
    </svg>`;
}

const ICON_STAR = `<svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M12 2l2.9 6.3 6.9.7-5.1 4.6 1.4 6.8L12 17.6 5.9 20.4l1.4-6.8L2.2 9l6.9-.7z"/></svg>`;
const ICON_DOWNLOAD = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M5 21h14"/></svg>`;
const ICON_BACK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M15 6l-6 6 6 6"/></svg>`;
const ICON_SHARE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M12 4v12"/><path d="M7 9l5-5 5 5"/><path d="M5 20h14"/></svg>`;
const CARD_ICONS = {
    ko:   `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" width="14" height="14"><circle cx="12" cy="12" r="7"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3"/></svg>`,
    bolt: `<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M13 2L4 14h6l-1 8 9-12h-6l1-8z"/></svg>`,
    send: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M5 12h14"/><path d="M13 6l6 6-6 6"/></svg>`,
    crown:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M3 7l4 5 5-7 5 7 4-5v11H3z"/></svg>`,
};

/**
 * Play Store nudge shown on the recap, Android only. Inside the APK it
 * asks for a rating; in an Android browser it drives the install. Both
 * route through openPlayStore(). Returns '' on non-Android so the card
 * never renders elsewhere.
 */
function storeNudgeHtml() {
    if (!shouldShowStoreNudge()) return '';
    const native = isCapacitorNative();
    const icon = native ? ICON_STAR : ICON_DOWNLOAD;
    const title = native ? 'Enjoying Leludo?' : 'Get the Leludo app';
    const body = native
        ? 'A quick Play Store rating helps a ton.'
        : 'Free on the Play Store — play offline, no ads.';
    const action = native ? 'Rate us' : 'Get the app';
    return `
        <button id="ge-store" class="ge-store" data-native="${native ? '1' : '0'}">
            <span class="ge-store-icon">${icon}</span>
            <span class="ge-store-text">
                <span class="ge-store-title">${title}</span>
                <span class="ge-store-body">${body}</span>
            </span>
            <span class="ge-store-action">${action}</span>
        </button>`;
}

function nameFor(pi) {
    const raw = playerNames[pi] && String(playerNames[pi]).trim();
    if (raw) return raw;
    return playerTypes[pi] === 'PLAYER' ? 'You' : 'Bot';
}

const ORDINALS = ['', '1st', '2nd', '3rd', '4th'];
function ordinal(rank) {
    return ORDINALS[rank] || `${rank}th`;
}

// Final standings: every seated player ordered by finishing rank (1 = winner).
// `highlightIndex` is the local board index of the player to flag as "You" —
// online's local self, so each client sees its own row highlighted. Unranked
// seats (rank 0 — shouldn't happen at game end) sort last.
function buildStandings(highlightIndex) {
    const rows = [];
    for (let i = 0; i < 4; i++) {
        if (!playerTypes[i]) continue;
        rows.push({
            playerIndex: i,
            rank: playerRanks[i] || 99,
            name: nameFor(i),
            isSelf: i === highlightIndex,
        });
    }
    rows.sort((a, b) => a.rank - b.rank);
    return rows;
}

const MEDALS = { 1: '🥇', 2: '🥈', 3: '🥉' };

function youPill(cls) {
    return `<span class="${cls}">You</span>`;
}

// One podium column. Step height is set by the .ge-pod-{rank} class; --seat
// carries the player's colour so the step tint, accent and self-highlight all
// derive from one value (no per-index CSS rules).
function podiumColumnHtml(s) {
    return `
        <div class="ge-pod ge-pod-${s.rank}${s.isSelf ? ' ge-pod-self' : ''}"
             style="--seat: var(--player-${s.playerIndex});">
            <div class="ge-pod-head">
                ${s.isSelf ? youPill('ge-pod-you') : ''}
                <span class="ge-pod-pawn">${pawnSvg(s.playerIndex, 34)}</span>
                <span class="ge-pod-name">${escapeHtml(s.name)}</span>
            </div>
            <div class="ge-pod-step">
                <span class="ge-pod-medal">${MEDALS[s.rank] || ''}</span>
                <span class="ge-pod-place">${ordinal(s.rank)}</span>
            </div>
        </div>`;
}

// The 4th-place row — last place, played for laughs. Deliberately styled
// lighter than a highlight card (transparent, dashed) so it never reads as
// another stat card. --seat carries the player's colour for the accent.
function loserRowHtml(s) {
    return `
        <div class="ge-loser${s.isSelf ? ' ge-loser-self' : ''}"
             style="--seat: var(--player-${s.playerIndex});">
            <span class="ge-loser-pawn">${pawnSvg(s.playerIndex, 26)}</span>
            <span class="ge-loser-text">
                <span class="ge-loser-name">${escapeHtml(s.name)}${s.isSelf ? ' ' + youPill('ge-loser-you') : ''}</span>
                <span class="ge-loser-tag">Better luck next time</span>
            </span>
            <span class="ge-loser-place">${ordinal(s.rank)}</span>
        </div>`;
}

// Standings as a podium: top 3 on stepped blocks (2nd | 1st | 3rd, tallest in
// the middle), and 4th — if present — as the wooden-spoon row beneath. Adapts
// to 2- and 3-player games (fewer steps, no spoon).
function podiumHtml(standings) {
    const top = standings.slice(0, 3);
    const loser = standings[3];
    // Visual order puts the winner centre-stage: [2nd, 1st, 3rd], skipping
    // slots that don't exist in a 2-player game.
    const cols = [1, 0, 2].filter((i) => i < top.length).map((i) => podiumColumnHtml(top[i]));
    return `
        <div class="ge-podium-row">${cols.join('')}</div>
        ${loser ? loserRowHtml(loser) : ''}`;
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

// Online only: a full 0..3 bijection between local board index and server seat.
// Active players use toServer(); empty chairs fill the leftover slots (their
// stats are null/default and get skipped during selection). Server seat is the
// stable identity every client agrees on, so selecting the recap in seat space
// makes index-tie-broken awards pick the same physical players everywhere.
function seatBijection() {
    const localOfSeat = new Array(4).fill(-1);
    const seatOfLocal = new Array(4).fill(-1);
    const seatTaken = [false, false, false, false];
    for (let local = 0; local < 4; local++) {
        if (!playerTypes[local]) continue;
        const seat = toServer(local);
        seatOfLocal[local] = seat;
        localOfSeat[seat] = local;
        seatTaken[seat] = true;
    }
    const spareSeats = [];
    for (let seat = 0; seat < 4; seat++) if (!seatTaken[seat]) spareSeats.push(seat);
    let spi = 0;
    for (let local = 0; local < 4; local++) {
        if (seatOfLocal[local] >= 0) continue;
        const seat = spareSeats[spi++];
        seatOfLocal[local] = seat;
        localOfSeat[seat] = local;
    }
    return { localOfSeat, seatOfLocal };
}

function buildHighlights(winnerIndex) {
    const seats = buildSeats();
    const stats = buildStats();
    if (!isOnlineActive()) return selectHighlights({ stats, seats, winnerIndex });
    const { localOfSeat, seatOfLocal } = seatBijection();
    return selectHighlightsBySeat({ stats, seats, winnerIndex, localOfSeat, seatOfLocal });
}

class GameEnd extends HTMLElement {
    connectedCallback() {
        let winnerIndex = 0;
        for (let pi = 0; pi < playerRanks.length; pi++) {
            if (playerRanks[pi] === 1) { winnerIndex = pi; break; }
        }

        const online = isOnlineActive();

        // Online every seat is a human, so "winner is a PLAYER" is true on every
        // client — only the actual winning client should read "You won". Offline,
        // the local human is whichever seat has type PLAYER.
        const isSelfWinner = online
            ? winnerIndex === onlineLocalSelf()
            : playerTypes[winnerIndex] === 'PLAYER';
        const winnerName = nameFor(winnerIndex);
        // Used by the shareable recap PNG, not shown on the screen itself.
        const winText = isSelfWinner ? 'You won.' : `${winnerName} won.`;

        const highlights = buildHighlights(winnerIndex);

        // Start rendering the shareable recap PNG now, while the user reads the
        // screen, so tapping Share opens the OS sheet without a render stall.
        primeShareImage(winnerIndex, winText, highlights);

        // Online: flag this client's own row ("You"). Offline the human is
        // already obvious, so leave every row unflagged.
        const highlightIndex = online ? onlineLocalSelf() : -1;
        const standingsHTML = podiumHtml(buildStandings(highlightIndex));

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

        // No achievement fired (e.g. a short, uneventful game) — the podium
        // already tells the story, so drop the empty Highlights section.
        const highlightsBlock = highlights.length
            ? `<div class="ge-section-label">Highlights</div>
               <div class="ge-cards">${cardsHTML}</div>`
            : '';

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
                        <h2 class="ge-headline">Game over</h2>
                    </div>

                    <div class="ge-scroll">
                        <div class="ge-podium">${standingsHTML}</div>

                        ${highlightsBlock}

                        ${storeNudgeHtml()}
                    </div>

                    <div class="ge-footer">
                        <button id="ge-play-again" class="ge-cta">${online ? 'New game' : 'Play again'}</button>
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
            // Offline replays the same lineup locally; online has no local
            // lineup to replay (server-driven) so a rematch means a new room —
            // route to the online create/join screen instead.
            dispatch({ type: online ? COMMANDS.ONLINE_NEW_GAME : COMMANDS.RESTART_GAME });
        });

        const storeBtn = el.querySelector('#ge-store');
        if (storeBtn) {
            storeBtn.addEventListener('click', () => {
                playClickSound();
                trackEvent('store_nudge_click', {
                    surface: 'game_end',
                    native: storeBtn.dataset.native === '1',
                });
                openPlayStore();
            });
        }

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
