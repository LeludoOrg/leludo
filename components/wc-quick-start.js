import {htmlToElement} from "./index.js";
import {dispatch, COMMANDS, playClickSound, escapeHtml} from "../scripts/index.js";
import {randomBotName, isDefaultBotName, getSavedSeatName, setSavedSeatName} from "../scripts/bot-names.js";
import {HUMAN_PREFERRED_POSITIONS} from "../scripts/game-logic.js";
import {goTo, replaceTo, back as navBack, registerScreenHandler} from "../scripts/nav-history.js";
import {NetClient, getConfiguredServerUrl, getSessionId, getUsername, setUsername} from "../scripts/net-client.js";
import {startOnlineGame, handleOnlineMessage, isOnlineGameStarted} from "../scripts/online-game.js";
import {showSelfReconnect, showSelfGaveUp, hideSelfBanner} from "../scripts/net-overlay.js";
import {mintRoomCode} from "../scripts/room-code.js";

// Initial release ships private rooms only. The public-matchmaking backend
// (queue + auto-start) stays wired and tested — this flag just hides the entry
// UI ("Find a public match"). Flip to true to bring it back; the public e2e
// suite in test/e2e/online-screens.spec.js is gated on the same switch.
const PUBLIC_MATCH_ENABLED = false;

// Public match: how long the "Match found!" announcement stays up before the
// board is revealed. The board mounts and runs underneath immediately — this is
// a purely cosmetic cover so an auto-started public game doesn't snap straight
// to the board with no breath. Private rooms skip it (players saw the lobby).
const MATCH_STARTING_MS = 2500;

const DICE_SVG = (value, size = 56) => {
    const PIP_LAYOUTS = {
        1: [[1,1]],
        2: [[0,0],[2,2]],
        3: [[0,0],[1,1],[2,2]],
        4: [[0,0],[0,2],[2,0],[2,2]],
        5: [[0,0],[0,2],[1,1],[2,0],[2,2]],
        6: [[0,0],[0,2],[1,0],[1,2],[2,0],[2,2]],
    };
    const pad = size * 0.2;
    const pip = size * 0.15;
    const cell = (size - pad * 2) / 2;
    const pips = PIP_LAYOUTS[value] || PIP_LAYOUTS[1];
    const pipSvgs = pips.map(([gr, gc]) =>
        `<circle cx="${pad + gc * cell}" cy="${pad + gr * cell}" r="${pip/2}" fill="var(--color-fg)"/>`
    ).join('');
    return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
        <rect x="0.5" y="0.5" width="${size - 1}" height="${size - 1}" rx="${size * 0.22}" fill="var(--color-surface)" stroke="var(--color-border)" stroke-width="1"/>
        ${pipSvgs}
    </svg>`;
};

const QUAD_CHIP_SVG = (size = 26) => MINI_BOARD_SVG(size);

const PLAY_ICON_SVG = (size = 14) =>
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`;

const MINI_BOARD_SVG = (size = 52) => {
    // Faithful to design/home.jsx MiniBoard: 2x2 colored quadrants
    // (each 50%), dark cross overlay sized at 1/3 of the box, tiny
    // off-white diamond at the center.
    // viewBox = 60 so the 1/3-thick cross sits at 20..40.
    return `<svg width="${size}" height="${size}" viewBox="0 0 60 60" style="border-radius:7px;overflow:hidden;display:block;">
        <rect x="0"  y="0"  width="30" height="30" fill="hsl(var(--player-1))"/>
        <rect x="30" y="0"  width="30" height="30" fill="hsl(var(--player-2))"/>
        <rect x="0"  y="30" width="30" height="30" fill="hsl(var(--player-3))"/>
        <rect x="30" y="30" width="30" height="30" fill="hsl(var(--player-0))"/>
        <!-- 1/3-thick dark cross (matches mockup's tinted lanes) -->
        <rect x="0"  y="20" width="60" height="20" fill="rgba(20,15,10,0.22)"/>
        <rect x="20" y="0"  width="20" height="60" fill="rgba(20,15,10,0.22)"/>
        <!-- center diamond -->
        <rect x="-3.4" y="-3.4" width="6.8" height="6.8"
              transform="translate(30 30) rotate(45)"
              fill="rgba(255,250,240,0.78)"/>
    </svg>`;
};

const PAWN_SVG = (playerIndex) => `
    <svg viewBox="0 0 32 32" class="player-fg-${playerIndex}" style="width:100%;height:100%;filter:drop-shadow(0 1.2px 1.5px rgba(0,0,0,0.28));">
        <ellipse cx="16" cy="28" rx="8" ry="1.5" fill="rgba(0,0,0,0.18)"/>
        <path d="M16 4c3.2 0 5.5 2.4 5.5 5.2 0 1.8-1 3.2-2.4 4 1.7.7 2.9 1.8 3.6 3.4l1.1 2.6c.4 1 .1 2-.7 2.4-.2.1-.4.1-.6.1H9.5c-.9 0-1.6-.7-1.6-1.6 0-.3.1-.6.2-.9l1.1-2.6c.7-1.6 1.9-2.7 3.6-3.4-1.4-.8-2.4-2.2-2.4-4C10.4 6.4 12.8 4 16 4z" fill="currentColor"/>
        <path d="M16 4c3.2 0 5.5 2.4 5.5 5.2 0 1.8-1 3.2-2.4 4-.6-.3-1.3-.5-2-.5h-2.2c-.7 0-1.4.2-2 .5-1.4-.8-2.4-2.2-2.4-4C10.4 6.4 12.8 4 16 4z" fill="rgba(255,255,255,0.24)"/>
        <rect x="7.5" y="22" width="17" height="3.5" rx="1.4" fill="currentColor"/>
        <rect x="7.5" y="22" width="17" height="1.2" rx="0.6" fill="rgba(255,255,255,0.38)"/>
    </svg>`;

const ICON_BACK = `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>`;
const ICON_CLOSE = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l12 12M18 6L6 18"/></svg>`;
const ICON_PLUS = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>`;
const ICON_USER = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 12a4 4 0 100-8 4 4 0 000 8zM4 21a8 8 0 0116 0"/></svg>`;
const ICON_BOT = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v3M8 7h8a3 3 0 013 3v7a3 3 0 01-3 3H8a3 3 0 01-3-3v-7a3 3 0 013-3zM9 13h.01M15 13h.01M9 17h6"/></svg>`;
const ICON_PENCIL = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9M16.5 3.5a2.121 2.121 0 113 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>`;
const ICON_GLOBE = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.5 2.5 15 0 18M12 3c-2.5 2.5-2.5 15 0 18"/></svg>`;
const ICON_DEVICE = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2" width="14" height="20" rx="2.5"/><path d="M11 18h2"/></svg>`;

class QuickStart extends HTMLElement {
    constructor() {
        super();
        const slots = [
            { type: 'PLAYER', colorIndex: 0 },
            { type: 'BOT', colorIndex: 1 },
            { type: 'BOT', colorIndex: 2 },
            { type: 'BOT', colorIndex: 3 },
        ];
        const botNames = [];
        this.seats = slots.map((slot, i) => {
            const saved = getSavedSeatName(slot.type, i);
            let name;
            if (slot.type === 'PLAYER') {
                name = saved || `Player ${i + 1}`;
            } else if (saved && !botNames.includes(saved)) {
                name = saved;
                botNames.push(name);
            } else {
                name = randomBotName(botNames);
                botNames.push(name);
            }
            return { active: true, type: slot.type, colorIndex: slot.colorIndex, name };
        });
        this._focusedSeatIndex = null;
    }

    _defaultName(seat, seatIndex) {
        const saved = getSavedSeatName(seat.type, seatIndex)
        if (seat.type !== 'BOT') return saved || `Player ${seatIndex + 1}`
        const used = this.seats.filter(s => s !== seat && s.active && s.type === 'BOT').map(s => s.name)
        if (saved && !used.includes(saved)) return saved
        return randomBotName(used)
    }

    _applyFocusUI() {
        const focused = this._focusedSeatIndex
        this.querySelectorAll('.seat-row').forEach(row => {
            const idx = +row.dataset.seatIdx
            row.style.opacity = (focused !== null && focused !== idx) ? '0.35' : ''
        })
        const helper = this.querySelector('#setup-helper')
        if (helper) helper.innerHTML = focused !== null ? helper.dataset.edit : helper.dataset.default
    }

    connectedCallback() {
        this.showHomeScreen()
        document.addEventListener("bot-name-pool-changed", () => this._reshuffleBotNames())
        registerScreenHandler('setup', () => this.showHomeScreen())
        registerScreenHandler('online', () => { this._leaveOnline(); this.showHomeScreen() })
        registerScreenHandler('online-search', () => { this._leaveOnline(); this.showOnlineScreen() })
        registerScreenHandler('online-lobby', () => { this._leaveOnline(); this.showOnlineScreen() })
    }

    _reshuffleBotNames() {
        const used = []
        this.seats.forEach((seat, idx) => {
            if (!seat.active || seat.type !== 'BOT') return
            if (getSavedSeatName('BOT', idx)) return
            if (!isDefaultBotName(seat.name)) return
            seat.name = randomBotName(used)
            used.push(seat.name)
        })
        if (this.querySelector('#seat-list')) this._renderSeats()
    }

    showHomeScreen() {
        // Returning home (incl. exiting an online game, whose driver already
        // closed the socket): drop any stale online references.
        this._inGame = false
        this._isPublic = false
        this._hideMatchStarting()
        this._net = null
        this.innerHTML = ""

        const saved = this._readSavedGame()

        const html = /*html*/ `
            <div class="frame home-frame${saved ? ' home-frame--in-progress' : ''}">
                <div class="top-bar">
                    <div class="icon-btn home-brand-chip" aria-label="leludo">${QUAD_CHIP_SVG(20)}</div>
                    <div class="top-bar-title"></div>
                    <wc-settings></wc-settings>
                </div>

                <div class="home-hero">
                    <div class="home-die"><div class="home-die-inner">${DICE_SVG(6, 48)}</div></div>
                    <h1 class="home-title">leludo</h1>
                    <p class="home-tagline">A quiet, faithful take on the classic four-player race.</p>
                </div>

                ${saved ? this._resumeCardHtml(saved) : ''}

                <div class="frame-footer home-cta-stack">
                    <button class="play-offline-btn new-game-btn cta-primary" data-testid="home-play-offline">${ICON_DEVICE}<span>${saved ? 'New offline game' : 'Play offline'}</span></button>
                    <button class="play-online-btn cta-secondary home-online-cta" data-testid="home-play-online">${ICON_GLOBE}<span>Play online</span></button>
                </div>
            </div>
        `

        const el = htmlToElement(html)

        el.querySelector(".play-offline-btn").addEventListener("click", () => {
            playClickSound()
            this.showSetupScreen()
            goTo('setup')
        })

        el.querySelector(".play-online-btn").addEventListener("click", () => {
            playClickSound()
            this.showOnlineScreen()
            goTo('online')
        })

        const resumeEl = el.querySelector(".resume-card")
        if (resumeEl) {
            resumeEl.addEventListener("click", () => {
                playClickSound()
                dispatch({ type: COMMANDS.RESUME_SAVED_GAME })
            })
        }

        this.appendChild(el)
        this._startHomeDieCycle()
    }

    _startHomeDieCycle() {
        this._stopHomeDieCycle()
        const die = this.querySelector('.home-die')
        const inner = this.querySelector('.home-die-inner')
        if (!die || !inner) return

        let colorIdx = 0
        let face = 6

        const cycle = () => {
            colorIdx = (colorIdx + 1) % 4
            die.style.backgroundColor = `hsl(var(--player-${colorIdx}))`
            die.style.setProperty('--pulse-color', `hsl(var(--player-${colorIdx}) / 0.55)`)
            inner.classList.remove('dice-rolling')
            void inner.offsetWidth
            inner.classList.add('dice-rolling')

            let n = 0
            const rollId = setInterval(() => {
                if (n >= 5) {
                    face = Math.floor(Math.random() * 6) + 1
                    inner.innerHTML = DICE_SVG(face, 48)
                    clearInterval(rollId)
                    return
                }
                face = (face % 6) + 1
                inner.innerHTML = DICE_SVG(face, 48)
                n++
            }, 70)
            this._homeDieRollId = rollId
        }

        this._homeDieInterval = setInterval(cycle, 2200)
    }

    _stopHomeDieCycle() {
        if (this._homeDieInterval) clearInterval(this._homeDieInterval)
        if (this._homeDieRollId) clearInterval(this._homeDieRollId)
        this._homeDieInterval = null
        this._homeDieRollId = null
    }

    disconnectedCallback() {
        this._stopHomeDieCycle()
        this._leaveOnline()
    }

    _readSavedGame() {
        try {
            const raw = localStorage.getItem('ludo-save')
            if (!raw) return null
            const parsed = JSON.parse(raw)
            if (!parsed || !Array.isArray(parsed.positions)) return null
            return parsed
        } catch {
            return null
        }
    }

    _resumeCardHtml(saved) {
        const types = saved.playerTypesArr || []
        const names = saved.playerNamesArr || []
        const cpi = saved.currentPlayerIndex ?? 0
        const turn = Number.isFinite(saved.turnCount) && saved.turnCount > 0 ? saved.turnCount : 1
        const activeIdx = [0,1,2,3].filter(i => types[i])
        const currentIsHuman = types[cpi] === 'PLAYER'
        const currentName = (names[cpi] || '').trim() || `Player ${cpi + 1}`
        const turnLine = currentIsHuman
            ? `Turn ${turn} · your move`
            : `Turn ${turn} · ${currentName}'s move`
        const opponents = activeIdx
            .filter(i => i !== cpi)
            .map(i => (names[i] || '').trim() || `P${i + 1}`)
            .join(', ')
        const dots = activeIdx.map(i =>
            `<span class="resume-dot" style="background:hsl(var(--player-${i}));"></span>`
        ).join('')

        return /*html*/ `
            <div class="home-resume-row">
                <div class="resume-eyebrow">IN&nbsp;PROGRESS</div>
                <button class="resume-card" type="button">
                    <span class="resume-mini-board">${MINI_BOARD_SVG(52)}</span>
                    <span class="resume-body">
                        <span class="resume-title">${escapeHtml(turnLine)}</span>
                        <span class="resume-sub">vs ${escapeHtml(opponents)}</span>
                        <span class="resume-dots">${dots}</span>
                    </span>
                    <span class="resume-play">${PLAY_ICON_SVG(14)}</span>
                </button>
            </div>`
    }

    showSetupScreen() {
        this._stopHomeDieCycle()
        this.innerHTML = ""

        const html = /*html*/ `
            <div class="frame">
                <div class="top-bar">
                    <button class="back-btn icon-btn">${ICON_BACK}</button>
                    <div class="top-bar-title"></div>
                    <wc-settings></wc-settings>
                </div>

                <div class="frame-body setup-body">
                    <h2 class="display-title">Who&rsquo;s playing?</h2>
                    <p id="setup-helper" class="setup-helper" data-default="Each seat is either a person on this phone or a bot.<br>Tap the pill to switch." data-edit="Rename your seat. Tap return when you&rsquo;re done.">Each seat is either a person on this phone or a bot.<br>Tap the pill to switch.</p>

                    <div id="seat-list" class="seat-list"></div>
                </div>

                <div class="frame-footer">
                    <button class="start-btn cta-primary">Start game</button>
                </div>
            </div>
        `

        const el = htmlToElement(html)

        el.querySelector(".back-btn").addEventListener("click", () => {
            playClickSound()
            navBack()
        })

        el.querySelector(".start-btn").addEventListener("click", () => {
            playClickSound()
            this._startGame()
        })

        this.appendChild(el)
        this._renderSeats()
    }

    _renderSeats() {
        const container = this.querySelector("#seat-list")
        if (!container) return
        container.innerHTML = ""

        this.seats.forEach((seat, i) => {
            const filled = seat.active

            if (filled) {
                const isPlayer = seat.type === 'PLAYER'
                const NAME_MAX = 9
                if (!seat.name) seat.name = this._defaultName(seat, i)
                // Seat colour is locked to its row position (seat 0 = red, 1 =
                // green, 2 = gold, 3 = blue). No per-seat colour picker.
                const colorVar = `hsl(var(--player-${i}))`
                const playerActiveStyle = isPlayer ? `style="background:${colorVar};color:#fff;"` : ''
                const botActiveStyle = !isPlayer ? `style="background:${colorVar};color:#fff;"` : ''
                const dimmed = this._focusedSeatIndex !== null && this._focusedSeatIndex !== i
                const rowDimStyle = dimmed ? 'opacity:0.35;' : ''
                const charLen = (seat.name || '').length
                const seatHtml = /*html*/ `
                    <div class="seat-row" data-seat-idx="${i}" style="${rowDimStyle}">
                        <div class="seat-color-cycle" style="background:${colorVar};">
                            <div class="seat-pawn">${PAWN_SVG(i)}</div>
                        </div>
                        <div class="seat-body">
                            <label class="seat-name-wrap">
                                <input class="seat-name" type="text" name="ludo-seat-${i}" autocomplete="off" autocorrect="off" autocapitalize="words" data-form-type="other" data-lpignore="true" data-1p-ignore="true" style="caret-color:${colorVar};" value="${(seat.name || '').replace(/"/g, '&quot;')}" maxlength="${NAME_MAX}" spellcheck="false" />
                                <span class="seat-name-pencil">${ICON_PENCIL}</span>
                                <span class="seat-char-count hidden" style="color:${colorVar};">${charLen}/${NAME_MAX}</span>
                            </label>
                        </div>
                        <div class="seat-pill">
                            <button data-half="PLAYER" class="seat-half ${isPlayer ? '' : 'seat-half--inactive'}" ${playerActiveStyle}>${ICON_USER}<span>Human</span></button>
                            <button data-half="BOT" class="seat-half ${!isPlayer ? '' : 'seat-half--inactive'}" ${botActiveStyle}>${ICON_BOT}<span>Bot</span></button>
                        </div>
                        <button class="remove-seat seat-remove">${ICON_CLOSE}</button>
                    </div>`
                const seatEl = htmlToElement(seatHtml)

                seatEl.querySelectorAll(".seat-half").forEach(btn => {
                    btn.addEventListener("click", () => {
                        const target = btn.dataset.half
                        if (target === seat.type) return
                        playClickSound()
                        seat.type = target
                        seat.name = this._defaultName({ ...seat, type: target }, i)
                        this._renderSeats()
                    })
                })

                const nameInput = seatEl.querySelector(".seat-name")
                const nameWrap = seatEl.querySelector(".seat-name-wrap")
                const charCount = seatEl.querySelector(".seat-char-count")
                const pencil = seatEl.querySelector(".seat-name-pencil")
                if (nameInput) {
                    const updateCount = () => {
                        if (charCount) charCount.textContent = `${(nameInput.value || '').length}/${nameInput.maxLength}`
                    }
                    nameInput.addEventListener("input", () => {
                        seat.name = nameInput.value
                        seat._edited = true
                        updateCount()
                    })
                    nameInput.addEventListener("focus", () => {
                        this._focusedSeatIndex = i
                        if (nameWrap) {
                            nameWrap.style.borderBottomColor = colorVar
                            nameWrap.style.borderBottomWidth = '1.5px'
                        }
                        if (charCount) charCount.classList.remove("hidden")
                        if (pencil) pencil.classList.add("hide-on-focus")
                        this._applyFocusUI()
                        const len = nameInput.value.length
                        nameInput.setSelectionRange(len, len)
                    })
                    nameInput.addEventListener("keydown", (e) => {
                        if (e.key === "Enter") { e.preventDefault(); nameInput.blur(); }
                    })
                    nameInput.addEventListener("blur", () => {
                        const trimmed = (nameInput.value || '').trim()
                        if (seat._edited) {
                            setSavedSeatName(seat.type, i, trimmed)
                        }
                        seat.name = trimmed || this._defaultName(seat, i)
                        seat._edited = false
                        nameInput.value = seat.name
                        if (nameWrap) {
                            nameWrap.style.borderBottomColor = ''
                            nameWrap.style.borderBottomWidth = ''
                        }
                        if (charCount) charCount.classList.add("hidden")
                        if (pencil) pencil.classList.remove("hide-on-focus")
                        this._focusedSeatIndex = null
                        this._applyFocusUI()
                    })
                }

                seatEl.querySelector(".remove-seat").addEventListener("click", () => {
                    playClickSound()
                    seat.active = false
                    seat.colorIndex = null
                    this._renderSeats()
                })

                container.appendChild(seatEl)
            } else {
                // Empty seat still previews its locked colour so the player
                // knows seat 0 = red, 1 = green, 2 = gold, 3 = blue up front.
                const ghostVar = `hsl(var(--player-${i}))`
                const emptyHtml = /*html*/ `
                    <div class="seat-row-empty">
                        <div class="seat-empty-color" style="border-color:color-mix(in srgb, ${ghostVar} 55%, transparent);background:color-mix(in srgb, ${ghostVar} 14%, transparent);">
                            <div class="seat-pawn seat-pawn-ghost">${PAWN_SVG(i)}</div>
                        </div>
                        <div class="seat-body">
                            <div class="seat-empty-title">Empty seat</div>
                            <div class="seat-empty-sub">Tap a side to fill</div>
                        </div>
                        <div class="seat-pill">
                            <button data-add="PLAYER" class="seat-add">${ICON_USER}<span>Human</span></button>
                            <button data-add="BOT" class="seat-add">${ICON_BOT}<span>Bot</span></button>
                        </div>
                    </div>`
                const emptyEl = htmlToElement(emptyHtml)
                const rowEl = emptyEl.firstElementChild
                const fillSeat = (target) => {
                    playClickSound()
                    seat.active = true
                    seat.type = target
                    seat.colorIndex = i
                    seat.name = this._defaultName({ ...seat, type: target, colorIndex: i }, i)
                    this._renderSeats()
                }
                rowEl.querySelectorAll(".seat-add").forEach(btn => {
                    btn.addEventListener("click", (e) => {
                        e.stopPropagation()
                        fillSeat(btn.dataset.add)
                    })
                })
                // Tapping anywhere else on the row fills it as a Human seat.
                rowEl.addEventListener("click", () => fillSeat("PLAYER"))
                container.appendChild(emptyEl)
            }
        })

        // Ensure at least 2 active players for start button
        const activeCount = this.seats.filter(s => s.active).length
        const startBtn = this.querySelector(".start-btn")
        if (startBtn) {
            startBtn.disabled = activeCount < 2
        }
    }

    // ===== Online (multiplayer) =====================================

    showOnlineScreen() {
        this._stopHomeDieCycle()
        this._isPublic = false
        this._leaveOnline()
        this._buildOnlineScreen()
    }

    // Builds the unified online screen. Opens in "setup" mode (seat 0 = YOU with
    // a name input, seats 1..3 Open/Bot toggles, join-by-code, "Create room").
    // Creating or joining flips THIS SAME screen into "room" mode via
    // _showRoomMode — the room code banner + live seats appear inline and the
    // footer swaps to Start/Leave. The old standalone "Game room" lobby is gone.
    _buildOnlineScreen() {
        this.innerHTML = ""
        // The online setup screen is just an identity + an entry point: join a
        // friend's room by code, or create your own. Seats and bots are managed
        // later, in room mode (the live seat list), so there are no Open/Bot
        // toggles here — only the host's name input.

        // Remembered username; fall back to the offline seat name as a suggestion.
        const savedName = (getUsername() || getSavedSeatName('PLAYER', 0) || '').slice(0, 12)

        const html = /*html*/ `
            <div class="frame">
                <div class="top-bar">
                    <button class="back-btn icon-btn">${ICON_BACK}</button>
                    <div class="top-bar-title">Play online</div>
                    <wc-settings></wc-settings>
                </div>

                <div class="frame-body setup-body online-setup-body">
                    <div class="online-room-slot"></div>

                    <div class="online-intro">
                        <h2 class="display-title">Play online</h2>
                        <p class="setup-helper">Join a friend's room with their code, or start your own.</p>
                    </div>

                    <div class="online-join-section">
                        <div class="online-join-row">
                            <input class="online-code-input" data-testid="online-code-input" type="text" inputmode="latin" autocapitalize="characters" autocomplete="off" autocorrect="off" spellcheck="false" maxlength="6" placeholder="ENTER CODE" />
                            <button class="online-join-btn cta-secondary" data-testid="online-join">Join</button>
                        </div>
                    </div>

                    <div class="online-divider online-new-room-divider"><span>or start a new room</span></div>

                    <div class="seat-list">
                        <div class="seat-row" data-testid="online-setup-seat-0">
                            <div class="seat-color-cycle" style="background:hsl(var(--player-0));">
                                <div class="seat-pawn">${PAWN_SVG(0)}</div>
                            </div>
                            <div class="seat-body">
                                <label class="seat-name-wrap">
                                    <input class="seat-name" data-testid="online-name" type="text" name="ludo-online-name" autocomplete="off" autocorrect="off" autocapitalize="words" data-form-type="other" data-lpignore="true" data-1p-ignore="true" style="caret-color:hsl(var(--player-0));" value="${escapeHtml(savedName)}" maxlength="12" spellcheck="false" placeholder="Your name" />
                                    <span class="seat-name-pencil">${ICON_PENCIL}</span>
                                </label>
                            </div>
                            <span class="online-you-tag">You</span>
                        </div>
                    </div>

                    <p class="online-status" data-testid="online-status"></p>
                    <span data-testid="online-started" hidden>false</span>
                    <span data-testid="online-is-host" hidden>false</span>
                </div>

                <div class="frame-footer">
                    <button class="online-create-btn cta-primary" data-testid="online-create">${ICON_PLUS}<span>Create room</span></button>
                    <button class="online-start-btn cta-primary" data-testid="online-start" hidden>${PLAY_ICON_SVG(13)}<span>Start game</span></button>
                    <button class="online-leave-btn cta-secondary" data-testid="online-leave" hidden>Leave room</button>
                </div>
            </div>
        `

        const el = htmlToElement(html)

        el.querySelector(".back-btn").addEventListener("click", () => { playClickSound(); navBack() })

        const nameInput = el.querySelector('[data-testid="online-name"]')
        // Remember the name as it's typed and clear any "enter a name" prompt.
        nameInput.addEventListener("input", () => {
            const v = (nameInput.value || '').trim()
            if (v) { setUsername(v); this._setOnlineStatus("") }
        })
        nameInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); nameInput.blur() } })

        el.querySelector('[data-testid="online-create"]').addEventListener("click", () => {
            if (!this._requireName()) return
            playClickSound()
            // Always a 4-seat room; the host fills empty seats with bots from the
            // live seat list in room mode.
            this._onlinePlayers = 4
            this._enterLobby(mintRoomCode(), { create: true })
        })

        const codeInput = el.querySelector(".online-code-input")
        const doJoin = () => {
            if (!this._requireName()) return
            const code = (codeInput.value || '').trim().toUpperCase()
            if (code.length < 4) {
                this._setOnlineStatus("Enter the 4-letter room code your host shared.")
                codeInput.focus()
                return
            }
            playClickSound()
            this._enterLobby(code, { create: false })
        }
        el.querySelector(".online-join-btn").addEventListener("click", doJoin)
        codeInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); doJoin() } })

        // Room-mode controls. Start/Leave stay hidden until _showRoomMode reveals
        // them; the per-seat host controls (kick/bot/open) are delegated on the
        // body so they survive _renderLobby rewriting the seat list.
        el.querySelector('[data-testid="online-start"]').addEventListener("click", () => { playClickSound(); this._net?.start() })
        el.querySelector('[data-testid="online-leave"]').addEventListener("click", () => { playClickSound(); navBack() })
        el.querySelector(".frame-body").addEventListener("click", (e) => {
            const btn = e.target.closest("[data-action]")
            if (!btn || !this._net) return
            const action = btn.dataset.action
            const seat = Number(btn.dataset.seat)
            playClickSound()
            if (action === "kick") this._net.kick(seat)
            else if (action === "bot") this._net.setSeat(seat, "BOT")
            else if (action === "open") this._net.setSeat(seat, "PLAYER")
        })

        this.appendChild(el)
    }

    // Flip the current online screen from setup mode into room mode: reveal the
    // room code, hide the intro + join-by-code, and swap "Create room" for
    // Start/Leave. Seats are filled by _renderLobby as server state arrives.
    _showRoomMode(code) {
        this._roomCode = code
        const setHidden = (sel, hidden) => { const e = this.querySelector(sel); if (e) e.hidden = hidden }
        const slot = this.querySelector(".online-room-slot")
        // Inject the code banner only in room mode, so the setup screen has no
        // online-room-code element (the "no room until you create one" guard).
        if (slot) slot.innerHTML = /*html*/ `
            <div class="online-room-banner">
                <span class="section-label">Room code</span>
                <div class="online-code-display" data-testid="online-room-code">${escapeHtml(code)}</div>
                <p class="online-room-share" data-testid="online-lobby-hint">Share this code with friends to let them join.</p>
            </div>`
        setHidden(".online-intro", true)
        setHidden(".online-join-section", true)
        setHidden(".online-new-room-divider", true)
        setHidden('[data-testid="online-create"]', true)
        setHidden('[data-testid="online-leave"]', false)
        this._setLobbyStatus("Connecting…")
    }

    /** Require a non-empty name before going online; remember it. Returns the
     *  trimmed name, or null (and prompts) when empty. */
    _requireName() {
        const input = this.querySelector('[data-testid="online-name"]')
        const name = (input?.value || '').trim()
        if (!name) {
            this._setOnlineStatus('Enter a name to play online.')
            input?.focus()
            return null
        }
        setUsername(name)
        return name
    }

    _setOnlineStatus(text) {
        const el = this.querySelector('[data-testid="online-status"]')
        if (el) el.textContent = text
    }

    _myName() {
        return (getUsername() || getSavedSeatName('PLAYER', 0) || 'Player').slice(0, 12)
    }

    // Single net-message handler shared by private rooms and public matchmaking.
    _onNetMessage(msg, client) {
        if (this._net !== client) return
        // Once the game has started, every message drives the board.
        if (this._inGame) { handleOnlineMessage(msg); return }
        switch (msg.t) {
            case 'queued':
                this._setSearchStatus(`Searching for a ${msg.size}-player match…`)
                break
            case 'matched':
                this._roomCode = msg.room
                this.showOnlineLobby(msg.room)
                replaceTo('online-lobby') // replace the search entry so back → menu
                // Public matches auto-start the instant seats fill, so cover the
                // brief lobby flash with a "Match found!" announcement.
                if (this._isPublic) this._showMatchStarting()
                break
            case 'seated':
                this._mySeat = msg.playerIndex
                this._isHost = !!msg.isHost
                break
            case 'state':
                this._renderLobby(msg.state)
                if (msg.state.started) {
                    // Hand off to the real board, server-driven from here on.
                    this._inGame = true
                    if (this._isPublic) this._updateMatchStartingNames(msg.state)
                    startOnlineGame({ net: this._net, seat: this._mySeat, state: msg.state })
                    const menu = document.getElementById('main-menu')
                    if (menu) menu.classList.add('hidden')
                    replaceTo('game')
                    // The board is now live under the announcement (if any). Reveal
                    // it once the minimum window has elapsed; private rooms have no
                    // overlay so this hides nothing.
                    if (this._isPublic) this._scheduleHideMatchStarting()
                    else this._hideMatchStarting()
                }
                break
            case 'kicked':
                this._leaveOnline()
                this.showOnlineScreen()
                replaceTo('online')
                this._setOnlineStatus('The host removed you from the room.')
                break
            case 'busy':
                this._onLobbyBusy(msg.reason)
                this._setSearchStatus('Servers are busy right now — please try again in a few minutes.')
                break
            default:
                break
        }
    }

    _connect({ room, params }) {
        this._leaveOnline()
        this._mySeat = -1
        // Test hook: forward a `?grace=` override so e2e can shorten the reconnect
        // window (the server only honours it under DEV_TEST_HOOKS).
        const extra = {}
        try {
            const g = new URLSearchParams(location.search).get('grace')
            if (g != null) extra.grace = g
        } catch { /* non-browser */ }
        const client = new NetClient({
            url: getConfiguredServerUrl(),
            room,
            session: getSessionId(),
            name: this._myName(),
            params: { ...params, ...extra },
            onClose: () => {
                if (this._net !== client || isOnlineGameStarted()) return
                // Surface a dead/unreachable server instead of spinning forever
                // on "Finding players…". Both setters no-op off their screen.
                this._setLobbyStatus('Disconnected from the server.')
                this._setSearchStatus('Couldn’t reach the server. Check your connection and try again.')
            },
            onMessage: (msg) => this._onNetMessage(msg, client),
            // Self-disconnect notices during a live game (net-client auto-retries).
            onReconnecting: () => { if (this._net === client && isOnlineGameStarted()) showSelfReconnect() },
            onReconnected: () => { if (this._net === client) hideSelfBanner() },
            onGiveUp: () => { if (this._net === client && isOnlineGameStarted()) showSelfGaveUp() },
        })
        this._net = client
        client.connect()
        return client
    }

    _enterLobby(code, { create }) {
        this._isPublic = false
        this._roomCode = code
        const players = create ? (this._onlinePlayers || 2) : 2
        // Flip the current setup screen into room mode in place — no separate
        // "Game room" screen. (Public matchmaking arrives from the search screen
        // instead and uses showOnlineLobby to build the room screen fresh.)
        this._showRoomMode(code)
        goTo('online-lobby')
        this._connect({ room: code, params: { size: String(players) } })
    }

    _enterMatchmaking(size) {
        this._isPublic = true
        this.showOnlineSearch(size)
        goTo('online-search')
        this._connect({ room: undefined, params: { mode: 'public', size: String(size) } })
    }

    showOnlineSearch(size) {
        this.innerHTML = ""
        const html = /*html*/ `
            <div class="frame">
                <div class="top-bar">
                    <button class="back-btn icon-btn">${ICON_BACK}</button>
                    <div class="top-bar-title">Public match</div>
                    <wc-settings></wc-settings>
                </div>

                <div class="frame-body online-search-body">
                    <div class="online-search-pulse pulse-chip">${QUAD_CHIP_SVG(40)}</div>
                    <h2 class="display-title">Finding players…</h2>
                    <p class="online-search-status" data-testid="online-search-status">Searching for a ${size}-player match…</p>
                </div>

                <div class="frame-footer">
                    <button class="cta-secondary" data-testid="online-search-cancel">Cancel</button>
                </div>
            </div>
        `
        const el = htmlToElement(html)
        el.querySelector(".back-btn").addEventListener("click", () => { playClickSound(); navBack() })
        el.querySelector('[data-testid="online-search-cancel"]').addEventListener("click", () => { playClickSound(); navBack() })
        this.appendChild(el)
    }

    _setSearchStatus(text) {
        const el = this.querySelector('[data-testid="online-search-status"]')
        if (el) el.textContent = text
    }

    // Build the online screen straight into room mode. Used by the public-match
    // path (PUBLIC_MATCH_ENABLED), which arrives already connected from the
    // search screen; private create/join flip in place via _showRoomMode.
    showOnlineLobby(code) {
        this._buildOnlineScreen()
        this._showRoomMode(code)
    }

    _setLobbyStatus(text) {
        const el = this.querySelector('[data-testid="online-status"]')
        if (el) el.textContent = text
    }

    // Render the live room into the shared seat-list, reusing the offline seat-row
    // look (pawn + name + status). Replaces the setup rows (seat-0 input + Open/Bot
    // toggles) the moment the first server state arrives.
    _renderLobby(state) {
        const isHost = state.hostSeat === this._mySeat && this._mySeat !== -1
        this._isHost = isHost
        const startBtn = this.querySelector('[data-testid="online-start"]')
        if (startBtn) startBtn.hidden = !isHost || state.started
        const isHostEl = this.querySelector('[data-testid="online-is-host"]')
        if (isHostEl) isHostEl.textContent = String(isHost)

        const activeSeats = (state.seats || []).filter(s => s.type) // PLAYER or BOT
        const seatList = this.querySelector('.seat-list')
        if (seatList) {
            const rows = [...activeSeats].sort((a, b) => a.index - b.index)
            seatList.innerHTML = rows.map(s => {
                const me = s.index === this._mySeat
                const isBot = s.type === 'BOT'
                let label, status
                if (isBot) { label = s.name || `Bot ${s.index + 1}`; status = 'Bot' }
                else if (s.connected) { label = s.name || `Player ${s.index + 1}`; status = s.isHost ? 'Host' : 'Ready' }
                else { label = 'Open seat'; status = 'Open' }
                const tags = me ? ' (you)' : ''

                // Host-only per-seat controls (never on the host's own seat).
                let controls = ''
                if (isHost && !state.started && !s.isHost) {
                    if (isBot) {
                        controls = `<button class="online-seat-btn" data-action="open" data-seat="${s.index}" data-testid="online-seat-${s.index}-open">Open</button>`
                    } else if (s.connected) {
                        controls = `<button class="online-seat-btn online-seat-btn--danger" data-action="kick" data-seat="${s.index}" data-testid="online-seat-${s.index}-kick">Kick</button>`
                    } else {
                        controls = `<button class="online-seat-btn" data-action="bot" data-seat="${s.index}" data-testid="online-seat-${s.index}-bot">Add bot</button>`
                    }
                }
                const dim = (!isBot && !s.connected) ? 0.4 : 1
                return /*html*/ `
                    <div class="seat-row" data-testid="online-seat-${s.index}">
                        <div class="seat-color-cycle" style="background:hsl(var(--player-${s.index}));opacity:${dim};">
                            <div class="seat-pawn">${PAWN_SVG(s.index)}</div>
                        </div>
                        <span class="online-seat-name">${escapeHtml(label)}${tags}</span>
                        <span class="online-seat-status">${status}</span>
                        ${controls}
                    </div>`
            }).join('')
        }

        const startedEl = this.querySelector('[data-testid="online-started"]')
        if (startedEl) startedEl.textContent = String(!!state.started)

        const humans = activeSeats.filter(s => s.type === 'PLAYER')
        const joined = humans.filter(s => s.connected).length
        if (state.started) {
            this._setLobbyStatus('Game starting…')
        } else if (isHost) {
            this._setLobbyStatus(`You're the host. ${joined} player${joined === 1 ? '' : 's'} in — start when ready.`)
        } else {
            this._setLobbyStatus('Waiting for the host to start…')
        }
    }

    _onLobbyBusy(reason) {
        this._setLobbyStatus('Servers are busy right now — please try again in a few minutes.')
        const startedEl = this.querySelector('[data-testid="online-started"]')
        if (startedEl) startedEl.textContent = 'false'
    }

    _leaveOnline() {
        // Don't kill the socket once the game has handed off to the board — the
        // online-game driver owns it then and closes it on exit.
        if (this._net && !this._inGame) {
            try { this._net.close() } catch { /* ignore */ }
        }
        this._net = null
        this._mySeat = -1
        this._inGame = false
        // NB: don't reset _isPublic here — _connect() calls _leaveOnline() right
        // before wiring the public socket, so clearing it here would clobber the
        // flag _enterMatchmaking just set. It's reset at true leave points
        // (showHomeScreen / showOnlineScreen) instead.
        this._hideMatchStarting()
    }

    // ----- "Match found!" announcement (public matches only) -----

    _showMatchStarting() {
        const el = document.getElementById('match-starting')
        if (!el) return
        const chip = el.querySelector('.match-starting-chip')
        if (chip && !chip.innerHTML) chip.innerHTML = QUAD_CHIP_SVG(40)
        this._setMatchStartingStatus('Setting up the board…')
        el.classList.remove('hidden')
        this._matchFoundAt = performance.now()
    }

    _setMatchStartingStatus(text) {
        const el = document.querySelector('#match-starting [data-testid="match-starting-status"]')
        if (el) el.textContent = text
    }

    // Once seated, name the opponents so the wait feels purposeful.
    _updateMatchStartingNames(state) {
        const types = state.playerTypes || []
        const names = state.playerNames || []
        const others = []
        for (let i = 0; i < types.length; i++) {
            if (!types[i] || i === this._mySeat) continue
            others.push(names[i] || (types[i] === 'BOT' ? 'Bot' : 'Player'))
        }
        if (!others.length) this._setMatchStartingStatus('Starting game…')
        else if (others.length === 1) this._setMatchStartingStatus(`Playing against ${others[0]}`)
        else this._setMatchStartingStatus(`Playing with ${others.join(' · ')}`)
    }

    _scheduleHideMatchStarting() {
        const elapsed = performance.now() - (this._matchFoundAt ?? performance.now())
        const wait = Math.max(0, MATCH_STARTING_MS - elapsed)
        clearTimeout(this._matchStartTimer)
        this._matchStartTimer = setTimeout(() => this._hideMatchStarting(), wait)
    }

    _hideMatchStarting() {
        clearTimeout(this._matchStartTimer)
        this._matchStartTimer = null
        const el = document.getElementById('match-starting')
        if (el) el.classList.add('hidden')
    }

    _startGame() {
        const activeSeats = this.seats.filter(s => s.active)
        if (activeSeats.length < 2) return

        const humans = activeSeats.filter(s => s.type === 'PLAYER')
        const bots = activeSeats.filter(s => s.type === 'BOT')
        const humanCount = humans.length
        const botCount = bots.length
        const humanColors = humans.map(s => s.colorIndex)
        const botColors = bots.map(s => s.colorIndex)

        const namesByPlayerIndex = new Array(4).fill('')
        if (humanCount === 4) {
            humans.forEach((s, idx) => { namesByPlayerIndex[idx] = s.name })
        } else {
            const preferredPositions = HUMAN_PREFERRED_POSITIONS
            const usedPositions = new Set()
            humans.forEach((s, idx) => {
                const pos = preferredPositions[idx]
                namesByPlayerIndex[pos] = s.name
                usedPositions.add(pos)
            })
            let botIdx = 0
            for (let pos = 0; pos < 4 && botIdx < botCount; pos++) {
                if (!usedPositions.has(pos)) {
                    namesByPlayerIndex[pos] = bots[botIdx].name
                    botIdx++
                }
            }
        }

        // Encode human colours then bot colours, both in seat order, so each
        // bot keeps its locked seat colour instead of grabbing a leftover one.
        const quickStartId = `qs,${humanCount},${botCount},${[...humanColors, ...botColors].join(",")}`
        dispatch({ type: COMMANDS.START_GAME, quickStartId, namesByPlayerIndex })
    }

}

window.customElements.define("wc-quick-start", QuickStart)
