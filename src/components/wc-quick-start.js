import {htmlToElement, onClickSound} from "./index.js";
import {dispatch, COMMANDS, playClickSound, escapeHtml} from "../scripts/index.js";
import {randomBotName, isDefaultBotName, getSavedSeatName, setSavedSeatName, getActivePoolKey} from "../scripts/core/bot-names.js";
import {HUMAN_PREFERRED_POSITIONS} from "../scripts/core/game-logic.js";
import {goTo, replaceTo, back as navBack, registerScreenHandler} from "../scripts/platform/nav-history.js";
import {NetClient, getConfiguredServerUrl, getSessionId, getUsername, getOnlineColor, setUsername, setOnlineColor} from "../scripts/net/net-client.js";
import {startOnlineGame, handleOnlineMessage, isOnlineGameStarted} from "../scripts/net/online-game.js";
import {showSelfReconnect, showSelfGaveUp, hideSelfBanner} from "../scripts/net/net-overlay.js";
import {MSG, ERR, NAME_MAX} from "../scripts/net/net-protocol.js";
import {STORAGE_KEYS} from "../scripts/platform/storage-keys.js";
import {SCREENS} from "../scripts/platform/screens.js";
import {mintRoomCode, ROOM_CODE_CHARS, ROOM_CODE_LENGTH} from "../scripts/core/room-code.js";
import {DICE_SVG, QUAD_CHIP_SVG, PLAY_ICON_SVG, MINI_BOARD_SVG, PAWN_SVG, ICON_BACK, ICON_CLOSE, ICON_USER, ICON_BOT, ICON_PENCIL, ICON_GLOBE, ICON_DEVICE} from "./wc-icons.js";
// The online flow lives in two sibling components this controller mounts and
// drives: <wc-play-online> (setup) and <wc-game-room> (lobby). Importing for
// the customElements.define side effect so the tags upgrade when inserted.
import "./wc-play-online.js";
import "./wc-game-room.js";

// Public match: how long the "Match found!" announcement stays up before the
// board is revealed. The board mounts and runs underneath immediately — this is
// a purely cosmetic cover so an auto-started public game doesn't snap straight
// to the board with no breath. Private rooms skip it (players saw the lobby).
const MATCH_STARTING_MS = 2500;

// SVG icon + chip helpers are shared across the menu/setup/online components —
// see ./wc-icons.js (imported above). Don't redefine them here.
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
        // AbortController so the global pool-change listener is removed on
        // disconnect instead of leaking across re-mounts.
        this._abort = new AbortController()
        document.addEventListener("bot-name-pool-changed", () => this._reshuffleBotNames(), { signal: this._abort.signal })
        // Register screen closers before any first navigation so back works even
        // when we boot straight into the online flow via a shared invite link.
        registerScreenHandler(SCREENS.SETUP, () => this.showHomeScreen())
        registerScreenHandler(SCREENS.ONLINE, () => { this._leaveOnline(); this.showHomeScreen() })
        registerScreenHandler(SCREENS.ONLINE_SEARCH, () => { this._leaveOnline(); this.showOnlineScreen() })
        registerScreenHandler(SCREENS.ONLINE_LOBBY, () => { this._leaveOnline(); this.showOnlineScreen() })

        // Deep link: opened via a shared "?join=CODE" invite → go straight into
        // the online flow; otherwise the normal home screen.
        const joinCode = this._readJoinLink()
        if (joinCode) this._enterFromLink(joinCode)
        else this.showHomeScreen()
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
        this._playOnline = null
        this._gameRoom = null
        this.innerHTML = ""

        const saved = this._readSavedGame()
        // Home is a segmented mode toggle (On this device / Online) above a single
        // "New game" button that routes by the selected mode. Online multiplayer
        // is live for everyone but still in beta — flagged by the "Beta" badge on
        // the Online segment. Mode persists across in-session home re-renders.
        if (this._homeMode == null) this._homeMode = 'device'
        const mode = this._homeMode

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

                <div class="home-actions-col">
                    ${saved ? this._resumeCardHtml(saved) : ''}

                    <div class="frame-footer home-cta-stack">
                        <div class="home-mode-toggle" role="tablist" aria-label="Game mode" data-mode="${mode}">
                            <div class="home-mode-thumb" aria-hidden="true"></div>
                            <button class="home-mode-seg" role="tab" data-mode="device" data-testid="home-mode-device" aria-selected="${mode === 'device'}">${ICON_DEVICE}<span>On this device</span></button>
                            <button class="home-mode-seg" role="tab" data-mode="online" data-testid="home-mode-online" aria-selected="${mode === 'online'}">${ICON_GLOBE}<span>Online</span><span class="home-mode-beta">Beta</span></button>
                        </div>
                        <button class="new-game-btn cta-primary" data-testid="home-new-game"><span>New game</span></button>
                        <p class="home-cta-sub" data-testid="home-cta-sub">${this._modeSubtext(mode)}</p>
                    </div>
                </div>
            </div>
        `

        const el = htmlToElement(html)

        el.querySelector(".new-game-btn").addEventListener("click", () => {
            playClickSound()
            if (this._homeMode === 'online') {
                this.showOnlineScreen()
                goTo(SCREENS.ONLINE)
            } else {
                this.showSetupScreen()
                goTo(SCREENS.SETUP)
            }
        })

        el.querySelectorAll(".home-mode-seg").forEach(seg => {
            seg.addEventListener("click", () => {
                const next = seg.dataset.mode
                if (next === this._homeMode) return
                playClickSound()
                this._setHomeMode(next)
            })
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

    // Subtext under the single CTA, narrating where "New game" leads in the
    // currently-selected mode.
    _modeSubtext(mode) {
        return mode === 'online'
            ? 'Play with friends in a private room'
            : 'Pass-and-play on this device'
    }

    // Flip the home mode toggle in place (no re-render): slide the thumb, swap
    // the selected segment, and update the CTA subtext. The New game button
    // reads this._homeMode at click time, so it always routes to the live mode.
    _setHomeMode(mode) {
        this._homeMode = mode
        const toggle = this.querySelector('.home-mode-toggle')
        if (toggle) toggle.dataset.mode = mode
        this.querySelectorAll('.home-mode-seg').forEach(seg => {
            seg.setAttribute('aria-selected', String(seg.dataset.mode === mode))
        })
        const sub = this.querySelector('.home-cta-sub')
        if (sub) sub.textContent = this._modeSubtext(mode)
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
        this._abort?.abort()
        this._abort = null
        this._stopHomeDieCycle()
        this._leaveOnline()
    }

    _readSavedGame() {
        try {
            const raw = localStorage.getItem(STORAGE_KEYS.SAVE)
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
            <div class="frame setup-frame">
                <div class="top-bar">
                    <button class="back-btn icon-btn">${ICON_BACK}</button>
                    <div class="top-bar-title"></div>
                    <wc-settings></wc-settings>
                </div>

                <div class="frame-body setup-body">
                    <div class="setup-heading">
                        <h2 class="display-title">Who&rsquo;s playing?</h2>
                        <p id="setup-helper" class="setup-helper" data-default="Each seat is either a person on this phone or a bot.<br>Tap the pill to switch." data-edit="Rename your seat. Tap return when you&rsquo;re done.">Each seat is either a person on this phone or a bot.<br>Tap the pill to switch.</p>
                    </div>

                    <div id="seat-list" class="seat-list"></div>
                </div>

                <div class="frame-footer">
                    <button class="start-btn cta-primary">Start game</button>
                    <p class="home-cta-sub">Pass the phone around on this device</p>
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
                                <input class="seat-name" type="text" name="ludo-seat-${i}" autocomplete="off" autocorrect="off" autocapitalize="words" data-form-type="other" data-lpignore="true" data-1p-ignore="true" style="caret-color:${colorVar};" value="${escapeHtml(seat.name || '')}" maxlength="${NAME_MAX}" spellcheck="false" />
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
        this.innerHTML = ""
        this._gameRoom = null
        const view = document.createElement('wc-play-online')
        this.appendChild(view)
        this._playOnline = view
        view.addEventListener('online-intent', (e) => this._onPlayOnlineIntent(e.detail))
    }

    // Setup screen (<wc-play-online>) asked to do something: go back, create a
    // room, or join one by code. The name is already validated + saved.
    _onPlayOnlineIntent({ kind, code }) {
        if (kind === 'back') { navBack(); return }
        if (kind === 'create') {
            // Always a 4-seat room; the host fills empty seats with bots from the
            // live seat list in the room.
            this._onlinePlayers = 4
            this._createRoom(mintRoomCode())
        } else if (kind === 'join') {
            this._joinRoom(code)
        }
    }

    // Mount the room screen (<wc-game-room>) with its code, starting in a
    // "Connecting…" state. Shared by private create/join and the public
    // "matched" path. The socket is wired separately by the caller (_connect)
    // and persists across the setup → room screen swap.
    _mountGameRoom(code) {
        this._stopHomeDieCycle()
        this.innerHTML = ""
        this._playOnline = null
        const view = document.createElement('wc-game-room')
        this.appendChild(view)
        view.setCode(code)
        // The room mounts in its own connecting state (skeleton seats + a
        // "Connecting you to the host…" line); no status line needed here.
        view.addEventListener('room-intent', (e) => this._onRoomIntent(e.detail))
        this._gameRoom = view
        return view
    }

    // Room screen (<wc-game-room>) asked to do something: leave/back, start the
    // game (host), or run a per-seat host control. Seats mirror offline: 'human'
    // opens the chair for a player, 'bot' drops a bot in, 'empty' clears it, and
    // 'kick' removes a player who already joined (reopening the chair).
    _onRoomIntent({ kind, action, seat, name }) {
        if (kind === 'back' || kind === 'leave') { navBack(); return }
        if (kind === 'start') { this._net?.start(); return }
        if (kind === 'share') { this._shareRoom(); return }
        if (kind === 'profile') {
            // Player set their own name / colour in the lobby. Remember it for next
            // time and forward to the server (it re-seats / renames authoritatively).
            if (name != null) setUsername(name)
            if (seat != null) setOnlineColor(seat)               // colour = chosen seat
            this._net?.setProfile({ name, seat })
            return
        }
        if (kind === 'seat') {
            if (!this._net) return
            if (action === 'kick') this._net.kick(seat)
            else if (action === 'bot') this._net.setSeat(seat, 'BOT')
            else if (action === 'human') this._net.setSeat(seat, 'PLAYER')
            else if (action === 'empty') this._net.setSeat(seat, 'CLOSED')
        }
    }

    // ----- Shared invite links (deep link in / OS share out) -----

    // Read a "?join=CODE" deep link. Returns the sanitized room code, or null
    // when absent/malformed (only the room-code alphabet, exact length).
    _readJoinLink() {
        try {
            const raw = new URLSearchParams(location.search).get('join')
            if (!raw) return null
            const code = raw.trim().toUpperCase()
            const valid = code.length === ROOM_CODE_LENGTH &&
                [...code].every(c => ROOM_CODE_CHARS.includes(c))
            return valid ? code : null
        } catch { return null }
    }

    // Boot straight into the online flow from a shared invite. Establish the
    // online setup screen as the back target, then: if we already know the
    // player's name, join straight into the game room; otherwise show setup with
    // the code pre-filled so they enter a name and tap Join.
    _enterFromLink(code) {
        // Consume the param so a later refresh / Back doesn't silently re-join.
        try {
            const url = new URL(location.href)
            url.searchParams.delete('join')
            history.replaceState(history.state, '', url.pathname + url.search + url.hash)
        } catch { /* non-browser */ }

        this.showOnlineScreen()
        goTo(SCREENS.ONLINE)
        if (getUsername()) this._joinRoom(code)
        else this._playOnline?.prefillJoin(code)
    }

    // Base URL a shared invite points back to. On the real web we reuse the
    // current origin; inside the Capacitor app (capacitor:// or https://localhost
    // shells) we can't link to a custom scheme, so point friends at the public
    // site instead.
    _shareBaseUrl() {
        const { origin, pathname, protocol, hostname } = location
        const realWeb = (protocol === 'https:' || protocol === 'http:') &&
            hostname !== 'localhost' && hostname !== '127.0.0.1'
        return realWeb ? `${origin}${pathname}` : 'https://leludo.org/'
    }

    // Open the OS share sheet with a join message + deep link. Falls back to
    // copying the link when the Web Share API is unavailable (e.g. desktop).
    async _shareRoom() {
        const code = this._roomCode
        if (!code) return
        const url = `${this._shareBaseUrl()}?join=${code}`
        const text = `Join my leludo game — room code ${code}.`
        try {
            if (navigator.share) {
                await navigator.share({ title: 'leludo', text, url })
                return
            }
            await navigator.clipboard?.writeText(url)
            this._setLobbyStatus('Invite link copied — paste it to a friend.')
        } catch (e) {
            // User dismissed the share sheet: leave the lobby as-is.
            if (e?.name === 'AbortError') return
            try {
                await navigator.clipboard?.writeText(url)
                this._setLobbyStatus('Invite link copied — paste it to a friend.')
            } catch { /* nothing more we can do */ }
        }
    }

    _setOnlineStatus(text) { this._playOnline?.setStatus(text) }

    // Friendly copy for a join rejection shown back on the setup screen. Keep
    // these short — they sit on one status line under the code field.
    _joinErrorText(error) {
        if (error === ERR.ROOM_FULL) return 'That room is full.'
        if (error === ERR.ROOM_NOT_FOUND) return 'No room with that code.'
        return 'Couldn’t join that room.'
    }

    _myName() {
        return (getUsername() || getSavedSeatName('PLAYER', 0) || 'Player').slice(0, NAME_MAX)
    }

    // Leave a game we can no longer be in — drop back to the online screen with a
    // reason instead of sitting frozen on a stale board. Shared by the forfeit
    // (ERROR/KICKED) and the game-gone (reconnect into a fresh lobby) paths.
    _exitDeadGame(message) {
        this._inGame = false
        dispatch({ type: COMMANDS.EXIT_TO_HOME })
        this.showOnlineScreen()
        replaceTo(SCREENS.ONLINE)
        this._setOnlineStatus(message)
    }

    // Single net-message handler shared by private rooms and public matchmaking.
    _onNetMessage(msg, client) {
        if (this._net !== client) return
        // Once the game has started, every message drives the board — except a
        // reconnect that lands us OUT of the game. Two shapes of that, both of
        // which would otherwise freeze the client on a dead board:
        //   1. ERROR/KICKED — our seat was forfeited while we were gone (the room
        //      is full or no longer exists).
        //   2. a STATE with started:false — we redialled into a FRESH lobby, i.e.
        //      the server lost the game and couldn't rebuild it (an un-restorable
        //      eviction: e.g. a deploy that changed the snapshot schema). An
        //      in-game room never reverts to started:false, so this only ever means
        //      "the game is gone". Without this the HOST in particular sat frozen,
        //      since handleOnlineMessage drops un-started snapshots.
        if (this._inGame) {
            if (msg.t === MSG.ERROR || msg.t === MSG.KICKED) {
                return this._exitDeadGame('Your seat was forfeited while you were disconnected.')
            }
            if (msg.t === MSG.STATE && msg.state && !msg.state.started) {
                return this._exitDeadGame('The game ended while you were disconnected.')
            }
            handleOnlineMessage(msg)
            return
        }
        switch (msg.t) {
            case MSG.QUEUED:
                this._setSearchStatus(`Searching for a ${msg.size}-player match…`)
                break
            case MSG.MATCHED:
                this._roomCode = msg.room
                this._mountGameRoom(msg.room)
                replaceTo(SCREENS.ONLINE_LOBBY) // replace the search entry so back → menu
                // Public matches auto-start the instant seats fill, so cover the
                // brief lobby flash with a "Match found!" announcement.
                if (this._isPublic) this._showMatchStarting()
                break
            case MSG.SEATED:
                // Host-ness is derived from state.hostSeat in <wc-game-room>;
                // we only need our own seat index here.
                this._mySeat = msg.playerIndex
                // A validated join: we connected from the setup screen and the
                // server has now confirmed our seat (the code was real and had
                // room). NOW mount the room screen + navigate; the STATE that
                // follows renders the lobby into it.
                if (this._pendingJoin) {
                    this._pendingJoin = false
                    this._playOnline?.setChecking(false)
                    this._mountGameRoom(this._roomCode || msg.roomId)
                    goTo(SCREENS.ONLINE_LOBBY)
                }
                break
            case MSG.STATE:
                this._gameRoom?.renderLobby(msg.state, this._mySeat)
                if (msg.state.started) {
                    // Hand off to the real board, server-driven from here on.
                    this._inGame = true
                    if (this._isPublic) this._updateMatchStartingNames(msg.state)
                    startOnlineGame({ net: this._net, seat: this._mySeat, state: msg.state, seq: msg.seq })
                    const menu = document.getElementById('main-menu')
                    if (menu) menu.classList.add('hidden')
                    replaceTo(SCREENS.GAME)
                    // The board is now live under the announcement (if any). Reveal
                    // it once the minimum window has elapsed; private rooms have no
                    // overlay so this hides nothing.
                    if (this._isPublic) this._scheduleHideMatchStarting()
                    else this._hideMatchStarting()
                }
                break
            case MSG.KICKED:
                this._leaveOnline()
                this.showOnlineScreen()
                replaceTo(SCREENS.ONLINE)
                this._setOnlineStatus('The host removed you from the room.')
                break
            case MSG.ERROR: {
                // A pre-game join failure: a bad/stale code (ROOM_NOT_FOUND) or a
                // full/closed room (ROOM_FULL). _leaveOnline closes the socket so
                // net-client won't auto-retry the dead code. For a validated join
                // we never left the setup screen — just clear the checking state
                // and show why (keeping the typed code). If we somehow already
                // navigated, rebuild the setup screen.
                const wasPending = this._pendingJoin
                this._pendingJoin = false
                this._leaveOnline()
                if (!wasPending && this._gameRoom) {
                    this.showOnlineScreen()
                    replaceTo(SCREENS.ONLINE)
                }
                this._playOnline?.setChecking(false)
                this._setOnlineStatus(this._joinErrorText(msg.error))
                break
            }
            case MSG.BUSY:
                this._gameRoom?.onBusy()
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
                // A join we were validating dropped before the server seated us
                // (server unreachable). Stay on the setup screen and surface it,
                // re-enabling the join button.
                if (this._pendingJoin) {
                    this._pendingJoin = false
                    this._playOnline?.setChecking(false)
                    this._setOnlineStatus('Couldn’t reach the server. Check your connection and try again.')
                    return
                }
                // Surface a dead/unreachable server instead of spinning forever
                // on "Finding players…". Both setters no-op off their screen.
                this._gameRoom?.setConnecting(false)
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

    // Create + enter a brand-new room as the host. The code is minted client-side
    // so there's nothing to validate — mount the room screen, navigate, then wire
    // the socket. The creator seeds the room: their colour pick + bot-name pool so
    // the auto-filled bots get cheeky names in the host's chosen language.
    _createRoom(code) {
        this._isPublic = false
        this._roomCode = code
        const params = {
            size: String(this._onlinePlayers || 2),
            create: '1',
            color: String(getOnlineColor()),
            pool: getActivePoolKey(),
        }
        // Navigate setup → room: mount <wc-game-room>, then wire the socket. The
        // 'online-lobby' history entry means back returns to <wc-play-online>.
        this._mountGameRoom(code)
        goTo(SCREENS.ONLINE_LOBBY)
        this._connect({ room: code, params })
    }

    // Join an existing room by code. The join socket IS the validation: we connect
    // from the setup screen and only navigate into the room once the server
    // confirms our seat (SEATED — see _onNetMessage). A bad/stale code
    // (ROOM_NOT_FOUND) or a full room (ROOM_FULL) comes back as an ERROR and we
    // stay right here with a message — no flashing into the room screen and back.
    _joinRoom(code) {
        this._isPublic = false
        this._roomCode = code
        this._playOnline?.setChecking(true)
        this._connect({ room: code, params: { size: '2', join: '1' } })
        // Set AFTER _connect: it runs _leaveOnline first, which clears this flag.
        this._pendingJoin = true
    }

    // ----- Public matchmaking (dormant) -----
    // No UI entry point calls this today — the initial release ships private
    // rooms only. The server half (matchmaker + MatchmakingDO) stays deployed
    // and tested; to relaunch public matches, add a button that calls
    // _enterMatchmaking(size). See src/server/cf/match-do.js for the remaining
    // client redial work.
    _enterMatchmaking(size) {
        this._isPublic = true
        this.showOnlineSearch(size)
        goTo(SCREENS.ONLINE_SEARCH)
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
        onClickSound(el.querySelector(".back-btn"), () => navBack())
        onClickSound(el.querySelector('[data-testid="online-search-cancel"]'), () => navBack())
        this.appendChild(el)
    }

    _setSearchStatus(text) {
        const el = this.querySelector('[data-testid="online-search-status"]')
        if (el) el.textContent = text
    }

    _setLobbyStatus(text) { this._gameRoom?.setStatus(text) }

    _leaveOnline() {
        // Don't kill the socket once the game has handed off to the board — the
        // online-game driver owns it then and closes it on exit.
        if (this._net && !this._inGame) {
            try { this._net.close() } catch { /* ignore */ }
        }
        this._net = null
        this._mySeat = -1
        this._inGame = false
        this._pendingJoin = false // cancel any in-flight join validation
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
