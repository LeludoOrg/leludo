import { htmlToElement } from "./index.js";
import { playClickSound, escapeHtml } from "../scripts/index.js";
import { ICON_BACK, PLAY_ICON_SVG, PAWN_SVG, ICON_SHARE, ICON_USER, ICON_BOT, ICON_CLOSE } from "./wc-icons.js";

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
                        <span class="section-label">Room code</span>
                        <div class="online-code-display" data-testid="online-room-code"></div>
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

        el.querySelector(".back-btn").addEventListener("click", () => { playClickSound(); this._emit('back') })
        el.querySelector('[data-testid="online-start"]').addEventListener("click", () => { playClickSound(); this._emit('start') })
        el.querySelector('[data-testid="online-share"]').addEventListener("click", () => { playClickSound(); this._emit('share') })
        el.querySelector('[data-testid="online-leave"]').addEventListener("click", () => { playClickSound(); this._emit('leave') })

        // Host per-seat controls (human / bot / empty / kick) are delegated on
        // the body so they survive renderLobby rewriting the seat list.
        el.querySelector(".frame-body").addEventListener("click", (e) => {
            const btn = e.target.closest("[data-action]")
            if (!btn) return
            playClickSound()
            this._emit('seat', { action: btn.dataset.action, seat: Number(btn.dataset.seat) })
        })

        this.appendChild(el)
    }

    _emit(kind, detail = {}) {
        this.dispatchEvent(new CustomEvent('room-intent', { detail: { kind, ...detail }, bubbles: true }))
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
        this.setStatus('Servers are busy right now — please try again in a few minutes.')
        const startedEl = this.querySelector('[data-testid="online-started"]')
        if (startedEl) startedEl.textContent = 'false'
    }

    // Render the live room into the seat-list, reusing the shared offline seat
    // look (components/seat-list.css). All four chairs render (Empty / Human /
    // Bot) so the host can configure each one. `mySeat` is this client's server
    // seat index (-1 until seated).
    renderLobby(state, mySeat) {
        const isHost = state.hostSeat === mySeat && mySeat !== -1
        const startBtn = this.querySelector('[data-testid="online-start"]')
        if (startBtn) startBtn.hidden = !isHost || state.started
        const isHostEl = this.querySelector('[data-testid="online-is-host"]')
        if (isHostEl) isHostEl.textContent = String(isHost)

        const canEdit = isHost && !state.started
        const seats = (state.seats || []).slice().sort((a, b) => a.index - b.index)
        const seatList = this.querySelector('.seat-list')
        if (seatList) {
            seatList.innerHTML = seats.map(s => this._seatRowHtml(s, mySeat, canEdit)).join('')
        }

        const startedEl = this.querySelector('[data-testid="online-started"]')
        if (startedEl) startedEl.textContent = String(!!state.started)

        const joined = seats.filter(s => s.type === 'PLAYER' && s.connected).length
        if (state.started) {
            this.setStatus('Game starting…')
        } else if (isHost) {
            this.setStatus(`You're the host. ${joined} player${joined === 1 ? '' : 's'} in — start when ready.`)
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
        let name, status, controls = ''
        if (isBot) {
            name = s.name || `Bot ${i + 1}`
            status = 'Bot'
            if (editable) controls = `<div class="seat-pill">${half('human', ICON_USER, 'Human', false)}${half('bot', ICON_BOT, 'Bot', true)}</div>${removeBtn('empty', 'Empty seat')}`
        } else if (joined) {
            name = (s.name || `Player ${i + 1}`) + (i === mySeat ? ' (you)' : '')
            status = s.isHost ? 'Host' : 'Ready'
            // A live player can't be silently retyped — kick them first (reopens the chair).
            if (editable) controls = removeBtn('kick', 'Remove player')
        } else {
            name = 'Open seat'
            status = 'Waiting for a player'
            if (editable) controls = `<div class="seat-pill">${half('human', ICON_USER, 'Human', true)}${half('bot', ICON_BOT, 'Bot', false)}</div>${removeBtn('empty', 'Empty seat')}`
        }
        const pawnDim = !isBot && !joined ? 'opacity:0.5;' : ''
        return /*html*/ `
            <div class="seat-row" data-testid="online-seat-${i}">
                <div class="seat-color-cycle" style="background:${colorVar};${pawnDim}">
                    <div class="seat-pawn">${PAWN_SVG(i)}</div>
                </div>
                <div class="seat-body">
                    <div class="online-seat-name">${escapeHtml(name)}</div>
                    <div class="seat-empty-sub">${status}</div>
                </div>
                ${controls}
            </div>`
    }
}

customElements.define('wc-game-room', GameRoom)
