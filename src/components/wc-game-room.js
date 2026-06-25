import { htmlToElement, onClickSound, emitIntent } from "./index.js";
import { playClickSound, escapeHtml } from "../scripts/index.js";
import { ICON_BACK, PLAY_ICON_SVG, PAWN_SVG, ICON_SHARE, ICON_USER, ICON_BOT, ICON_CLOSE, ICON_PENCIL } from "./wc-icons.js";

// The "Game room" lobby: the room code to share, the live seat list, and (for
// the host) Start + per-seat controls. It renders server state pushed in via
// renderLobby() and emits a `room-intent` ({kind:'start'|'leave'|'back'|'seat'|
// 'share', action?, seat?}) for wc-quick-start (the net controller) to act on —
// the component never touches the socket (or the OS share sheet) itself.
//
// Seats mirror the OFFLINE setup (components/seat-list.css): every chair is
// Empty, a Human, or a Bot. The host configures each chair exactly like offline
// — tap Human/Bot to fill an empty chair, toggle Human↔Bot, or × to empty it —
// the only online extra is Kick (remove a player who has already joined). A
// Human chair nobody joined becomes a bot when the game starts (server side).
//   action → net intent: 'human'→PLAYER  'bot'→BOT  'empty'→CLOSED  'kick'→kick
class GameRoom extends HTMLElement {
    connectedCallback() {
        const html = /*html*/ `
            <div class="frame">
                <div class="top-bar">
                    <button class="back-btn icon-btn">${ICON_BACK}</button>
                    <div class="top-bar-title">Game room</div>
                    <wc-settings></wc-settings>
                </div>

                <div class="frame-body online-room-body">
                    <div class="online-room-banner">
                        <span class="section-label" data-testid="online-room-eyebrow">Room code</span>
                        <div class="online-code-display" data-testid="online-room-code"></div>
                        <div class="online-connecting" data-testid="online-connecting">
                            <span class="online-connecting-dot"></span>
                            <span>Connecting you to the host…</span>
                        </div>
                        <p class="online-room-share" data-testid="online-lobby-hint">Share the invite so friends can tap to join.</p>
                        <button class="online-share-btn cta-secondary" data-testid="online-share">${ICON_SHARE}<span>Share invite</span></button>
                    </div>

                    <div class="seat-list"></div>

                    <p class="online-status" data-testid="online-status"></p>
                    <span data-testid="online-started" hidden>false</span>
                    <span data-testid="online-is-host" hidden>false</span>
                </div>

                <div class="frame-footer">
                    <button class="online-start-btn cta-primary" data-testid="online-start" hidden>${PLAY_ICON_SVG(13)}<span>Start game</span></button>
                    <button class="online-leave-btn cta-secondary" data-testid="online-leave">Leave room</button>
                </div>
            </div>
        `

        const el = htmlToElement(html)

        onClickSound(el.querySelector(".back-btn"), () => this._emit('back'))
        onClickSound(el.querySelector('[data-testid="online-start"]'), () => this._emit('start'))
        onClickSound(el.querySelector('[data-testid="online-share"]'), () => this._emit('share'))
        onClickSound(el.querySelector('[data-testid="online-leave"]'), () => this._emit('leave'))

        // Your name lives on your own seat row (like the offline setup). Commit on
        // blur / Enter — not per keystroke — so it's one message per edit; the
        // server clamps + echoes it back via renderLobby. Delegated on the body so
        // it survives renderLobby rewriting the seat list.
        const body = el.querySelector(".frame-body")
        body.addEventListener("change", (e) => {
            const input = e.target.closest('.seat-name')
            if (!input) return
            const v = (input.value || '').trim()
            if (v) this._emit('profile', { name: v })
        })
        body.addEventListener("keydown", (e) => {
            if (e.key === "Enter" && e.target.closest('.seat-name')) { e.preventDefault(); e.target.blur() }
        })
        // Focus UI (mirrors the offline setup): editing your name tints your seat's
        // underline in your colour, hides the pencil, and mutes the other seats.
        body.addEventListener("focusin", (e) => {
            if (e.target.closest('.seat-name')) this._setEditing(e.target, true)
        })
        body.addEventListener("focusout", (e) => {
            if (e.target.closest('.seat-name')) this._setEditing(e.target, false)
        })

        // Host per-seat controls (human / bot / empty / kick) are delegated on the
        // body too, so they survive renderLobby rewriting the seat list.
        body.addEventListener("click", (e) => {
            const btn = e.target.closest("[data-action]")
            if (!btn) return
            playClickSound()
            this._emit('seat', { action: btn.dataset.action, seat: Number(btn.dataset.seat) })
        })

        this.appendChild(el)
        // Mount straight into the "connecting" state: shimmering seat skeletons +
        // a "Connecting you to the host…" line until the first lobby STATE lands.
        this.setConnecting(true)
    }

    // Toggle the pre-lobby connecting state. While on: the banner reads "Joining
    // room", the share invite line/button hide (nothing to share yet), and the
    // seat-list shows shimmering skeleton rows (count mirrors the four chairs a
    // room can hold). renderLobby/onBusy flip it off once real state arrives.
    setConnecting(on) {
        this.classList.toggle('is-connecting', on)
        const eyebrow = this.querySelector('[data-testid="online-room-eyebrow"]')
        if (eyebrow) eyebrow.textContent = on ? 'Joining room' : 'Room code'
        if (on) {
            this.setStatus('')
            const seatList = this.querySelector('.seat-list')
            if (seatList) seatList.innerHTML = Array.from({ length: 4 }, () => this._seatSkeletonHtml()).join('')
        }
    }

    // One shimmering placeholder row, matching the real seat-row geometry (44px
    // colour chip + name/status lines). Pure decoration — hidden from a11y.
    _seatSkeletonHtml() {
        return /*html*/ `
            <div class="seat-row seat-skeleton" aria-hidden="true">
                <div class="skeleton-block skeleton-chip"></div>
                <div class="seat-body">
                    <div class="skeleton-block skeleton-line skeleton-line-name"></div>
                    <div class="skeleton-block skeleton-line skeleton-line-sub"></div>
                </div>
            </div>`
    }

    // Toggle the "editing your name" UI: tint your seat's underline in your colour
    // + hide its pencil, and mute every other seat row. Mirrors the offline setup
    // (wc-quick-start `_applyFocusUI`). Re-applied automatically when renderLobby
    // restores focus after a state-push re-render.
    _setEditing(input, on) {
        const row = input.closest('.seat-row')
        const wrap = input.closest('.seat-name-wrap')
        if (wrap) {
            // The input's caret colour is already its player colour — reuse it.
            wrap.style.borderBottomColor = on ? input.style.caretColor : ''
            wrap.style.borderBottomWidth = on ? '1.5px' : ''
            wrap.querySelector('.seat-name-pencil')?.classList.toggle('hide-on-focus', on)
        }
        this.querySelectorAll('.seat-row, .seat-row-empty').forEach(r => {
            r.style.opacity = on && r !== row ? '0.35' : ''
        })
    }

    _emit(kind, detail = {}) {
        emitIntent(this, 'room-intent', kind, detail)
    }

    setCode(code) {
        const el = this.querySelector('[data-testid="online-room-code"]')
        if (el) el.textContent = code
    }

    setStatus(text) {
        const el = this.querySelector('[data-testid="online-status"]')
        if (el) el.textContent = text
    }

    /** Servers are busy: surface it and make sure the room reads "not started". */
    onBusy() {
        this.setConnecting(false)
        const seatList = this.querySelector('.seat-list')
        if (seatList) seatList.innerHTML = ''
        this.setStatus('Servers are busy right now — please try again in a few minutes.')
        const startedEl = this.querySelector('[data-testid="online-started"]')
        if (startedEl) startedEl.textContent = 'false'
    }

    // Render the live room into the seat-list, reusing the shared offline seat
    // look (components/seat-list.css). All four chairs render (Empty / Human /
    // Bot) so the host can configure each one. `mySeat` is this client's server
    // seat index (-1 until seated).
    renderLobby(state, mySeat) {
        // First real state ends the connecting/skeleton phase.
        this.setConnecting(false)
        const isHost = state.hostSeat === mySeat && mySeat !== -1
        // An online game needs two real people. Bots fill the remaining seats on
        // start, but they don't count toward the minimum — so the host's Start
        // stays disabled (visible, greyed) until a second human joins. The server
        // enforces the same rule (handleStart → NEED_TWO_PLAYERS); this is the UX.
        const humans = (state.seats || []).filter(s => s.type === 'PLAYER' && s.claimed).length
        const startBtn = this.querySelector('[data-testid="online-start"]')
        if (startBtn) {
            startBtn.hidden = !isHost || state.started
            startBtn.disabled = humans < 2
        }

        const isHostEl = this.querySelector('[data-testid="online-is-host"]')
        if (isHostEl) isHostEl.textContent = String(isHost)

        const canEdit = isHost && !state.started
        const seats = (state.seats || []).slice().sort((a, b) => a.index - b.index)
        const seatList = this.querySelector('.seat-list')
        if (seatList) {
            // Preserve an in-progress rename: the list is innerHTML-rewritten on
            // every state push (another player joining/leaving), which would drop
            // focus + the half-typed value of your own seat-name field. Capture,
            // re-render, restore. Only your own seat renders an editable input, so
            // there's at most one .seat-name to track.
            const active = seatList.querySelector('.seat-name:focus')
            const saved = active ? { value: active.value, start: active.selectionStart, end: active.selectionEnd } : null
            seatList.innerHTML = seats.map(s => this._seatRowHtml(s, mySeat, canEdit)).join('')
            if (saved) {
                const fresh = seatList.querySelector('.seat-name')
                if (fresh) {
                    fresh.value = saved.value
                    fresh.focus()
                    try { fresh.setSelectionRange(saved.start, saved.end) } catch { /* unsupported */ }
                }
            }
        }

        const startedEl = this.querySelector('[data-testid="online-started"]')
        if (startedEl) startedEl.textContent = String(!!state.started)

        const joined = seats.filter(s => s.type === 'PLAYER' && s.connected).length
        if (state.started) {
            this.setStatus('Game starting…')
        } else if (isHost) {
            // Until a second human is in, the host can't start — prompt them to
            // share the code rather than dangle a dead Start button.
            this.setStatus(humans < 2
                ? 'Share the room code — you need one more player to start.'
                : `You're the host. ${joined} player${joined === 1 ? '' : 's'} in — start when ready.`)
        } else {
            this.setStatus('Waiting for the host to start…')
        }
    }

    // One seat row. Three states mirror offline: Empty (tap Human/Bot to fill),
    // Human (joined → name + Kick; open → "waiting" + Human|Bot toggle + ×), Bot
    // (name + Human|Bot toggle + ×). Controls render for the host only, and never
    // on the host's own chair. The Human|Bot pill + × match the offline setup.
    _seatRowHtml(s, mySeat, canEdit) {
        const i = s.index
        const colorVar = `hsl(var(--player-${i}))`
        const editable = canEdit && !s.isHost          // can't retype the host's own chair
        const fillBtn = (action, icon, txt) =>
            `<button class="seat-add" data-action="${action}" data-seat="${i}" data-testid="online-seat-${i}-${action}">${icon}<span>${txt}</span></button>`
        const half = (action, icon, txt, active) =>
            `<button class="seat-half ${active ? '' : 'seat-half--inactive'}" ${active ? `style="background:${colorVar};color:#fff;"` : ''} data-action="${action}" data-seat="${i}" data-testid="online-seat-${i}-${action}">${icon}<span>${txt}</span></button>`
        const removeBtn = (action, title) =>
            `<button class="seat-remove" data-action="${action}" data-seat="${i}" data-testid="online-seat-${i}-${action}" title="${title}">${ICON_CLOSE}</button>`
        // A joined player is a real person — kicking them is a distinct, labelled
        // action, not the bare × used to empty a bot/open chair (which reads as
        // "remove this slot", not "remove this human").
        const kickBtn = () =>
            `<button class="online-seat-btn online-seat-btn--danger" data-action="kick" data-seat="${i}" data-testid="online-seat-${i}-kick" title="Remove player">Kick</button>`

        // ---- Empty chair: tap a side to fill (host only). ----
        if (!s.type) {
            const fill = editable
                ? `<div class="seat-pill">${fillBtn('human', ICON_USER, 'Human')}${fillBtn('bot', ICON_BOT, 'Bot')}</div>`
                : ''
            return /*html*/ `
                <div class="seat-row-empty" data-testid="online-seat-${i}">
                    <div class="seat-empty-color">
                        <div class="seat-pawn seat-pawn-ghost">${PAWN_SVG(i)}</div>
                    </div>
                    <div class="seat-body">
                        <div class="seat-empty-title">Empty seat</div>
                        ${editable ? '<div class="seat-empty-sub">Tap a side to fill</div>' : ''}
                    </div>
                    ${fill}
                </div>`
        }

        // ---- Filled chair: Human (joined / open) or Bot. ----
        const isBot = s.type === 'BOT'
        const joined = s.claimed
        const isMe = i === mySeat
        let name, status, controls = ''
        if (isBot) {
            name = s.name || `Bot ${i + 1}`
            status = 'Bot'
            if (editable) controls = `<div class="seat-pill">${half('human', ICON_USER, 'Human', false)}${half('bot', ICON_BOT, 'Bot', true)}</div>${removeBtn('empty', 'Empty seat')}`
        } else if (joined) {
            name = s.name || `Player ${i + 1}`
            status = isMe ? `(you)${s.isHost ? ' · Host' : ''}` : (s.isHost ? 'Host' : 'Ready')
            // A live player can't be silently retyped — kick them first (reopens the chair).
            if (editable) controls = kickBtn()
        } else {
            name = 'Open seat'
            status = 'Waiting for a player'
            if (editable) controls = `<div class="seat-pill">${half('human', ICON_USER, 'Human', true)}${half('bot', ICON_BOT, 'Bot', false)}</div>${removeBtn('empty', 'Empty seat')}`
        }
        const pawnDim = !isBot && !joined ? 'opacity:0.5;' : ''
        // Your own seat carries an inline editable name (mirrors the offline setup);
        // everyone else's name is static text. The rename commits on blur / Enter.
        const nameHtml = (isMe && joined)
            ? /*html*/ `<label class="seat-name-wrap">
                    <input class="seat-name" data-testid="online-name" type="text" name="ludo-online-name" autocomplete="off" autocorrect="off" autocapitalize="words" data-form-type="other" data-lpignore="true" data-1p-ignore="true" style="caret-color:${colorVar};" value="${escapeHtml(name)}" maxlength="12" spellcheck="false" placeholder="Your name" />
                    <span class="seat-name-pencil">${ICON_PENCIL}</span>
                </label>`
            : `<div class="online-seat-name">${escapeHtml(name)}</div>`
        return /*html*/ `
            <div class="seat-row" data-testid="online-seat-${i}">
                <div class="seat-color-cycle" style="background:${colorVar};${pawnDim}">
                    <div class="seat-pawn">${PAWN_SVG(i)}</div>
                </div>
                <div class="seat-body">
                    ${nameHtml}
                    <div class="seat-empty-sub">${status}</div>
                </div>
                ${controls}
            </div>`
    }
}

customElements.define('wc-game-room', GameRoom)
