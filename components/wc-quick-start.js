import {htmlToElement} from "./index.js";
import {dispatch, COMMANDS, playClickSound, escapeHtml} from "../scripts/index.js";
import {randomBotName, isDefaultBotName, getSavedSeatName, setSavedSeatName} from "../scripts/bot-names.js";
import {HUMAN_PREFERRED_POSITIONS} from "../scripts/game-logic.js";
import {goTo, back as navBack, registerScreenHandler} from "../scripts/nav-history.js";

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

                <div class="frame-footer">
                    ${saved
                        ? `<button class="new-game-btn cta-primary">Start a new game</button>`
                        : `<button class="new-game-btn cta-primary">New game</button>`}
                </div>
            </div>
        `

        const el = htmlToElement(html)

        el.querySelector(".new-game-btn").addEventListener("click", () => {
            playClickSound()
            this.showSetupScreen()
            goTo('setup')
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
            const usedColors = this.seats.filter((s, j) => s.active && j !== i).map(s => s.colorIndex)

            if (filled) {
                const isPlayer = seat.type === 'PLAYER'
                const NAME_MAX = 9
                if (!seat.name) seat.name = this._defaultName(seat, i)
                const colorVar = `hsl(var(--player-${seat.colorIndex}))`
                const playerActiveStyle = isPlayer ? `style="background:${colorVar};color:#fff;"` : ''
                const botActiveStyle = !isPlayer ? `style="background:${colorVar};color:#fff;"` : ''
                const dimmed = this._focusedSeatIndex !== null && this._focusedSeatIndex !== i
                const rowDimStyle = dimmed ? 'opacity:0.35;' : ''
                const charLen = (seat.name || '').length
                const seatHtml = /*html*/ `
                    <div class="seat-row" data-seat-idx="${i}" style="${rowDimStyle}">
                        <button class="color-cycle seat-color-cycle" style="background:${colorVar};" title="Change color">
                            <div class="seat-pawn">${PAWN_SVG(seat.colorIndex)}</div>
                        </button>
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

                seatEl.querySelector(".color-cycle").addEventListener("click", () => {
                    playClickSound()
                    let next = (seat.colorIndex + 1) % 4
                    while (usedColors.includes(next)) next = (next + 1) % 4
                    seat.colorIndex = next
                    this._renderSeats()
                })

                seatEl.querySelector(".remove-seat").addEventListener("click", () => {
                    playClickSound()
                    seat.active = false
                    seat.colorIndex = null
                    this._renderSeats()
                })

                container.appendChild(seatEl)
            } else {
                const emptyHtml = /*html*/ `
                    <div class="seat-row-empty">
                        <div class="seat-empty-color"></div>
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
                emptyEl.querySelectorAll(".seat-add").forEach(btn => {
                    btn.addEventListener("click", () => {
                        playClickSound()
                        const usedAll = this.seats.filter(s => s.active).map(s => s.colorIndex)
                        const freeColor = [0,1,2,3].find(c => !usedAll.includes(c))
                        if (freeColor === undefined) return
                        const target = btn.dataset.add
                        seat.active = true
                        seat.type = target
                        seat.colorIndex = freeColor
                        seat.name = this._defaultName({ ...seat, type: target, colorIndex: freeColor }, i)
                        this._renderSeats()
                    })
                })
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

    _startGame() {
        const activeSeats = this.seats.filter(s => s.active)
        if (activeSeats.length < 2) return

        const humans = activeSeats.filter(s => s.type === 'PLAYER')
        const bots = activeSeats.filter(s => s.type === 'BOT')
        const humanCount = humans.length
        const botCount = bots.length
        const humanColors = humans.map(s => s.colorIndex)

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

        const quickStartId = `qs,${humanCount},${botCount},${humanColors.join(",")}`
        dispatch({ type: COMMANDS.START_GAME, quickStartId, namesByPlayerIndex })
    }

}

window.customElements.define("wc-quick-start", QuickStart)
