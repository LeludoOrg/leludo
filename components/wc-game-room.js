import { htmlToElement } from "./index.js";
import { playClickSound, escapeHtml } from "../scripts/index.js";
import { ICON_BACK, PLAY_ICON_SVG, PAWN_SVG } from "./wc-icons.js";

// The "Game room" lobby: the room code to share, the live seat list, and (for
// the host) Start + per-seat controls. It renders server state pushed in via
// renderLobby() and emits a `room-intent` ({kind:'start'|'leave'|'back'|'seat',
// action?, seat?}) for wc-quick-start (the net controller) to act on — the
// component never touches the socket itself.
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
                        <p class="online-room-share" data-testid="online-lobby-hint">Share this code with friends to let them join.</p>
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
        el.querySelector('[data-testid="online-leave"]').addEventListener("click", () => { playClickSound(); this._emit('leave') })

        // Host per-seat controls (kick / add-bot / open) are delegated on the
        // body so they survive renderLobby rewriting the seat list.
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

    // Render the live room into the seat-list, reusing the shared seat-row look
    // (pawn + name + status). `mySeat` is this client's server seat index (-1
    // until seated). Mirrors the old in-place lobby render, now owned here.
    renderLobby(state, mySeat) {
        const isHost = state.hostSeat === mySeat && mySeat !== -1
        const startBtn = this.querySelector('[data-testid="online-start"]')
        if (startBtn) startBtn.hidden = !isHost || state.started
        const isHostEl = this.querySelector('[data-testid="online-is-host"]')
        if (isHostEl) isHostEl.textContent = String(isHost)

        const activeSeats = (state.seats || []).filter(s => s.type) // PLAYER or BOT
        const seatList = this.querySelector('.seat-list')
        if (seatList) {
            const rows = [...activeSeats].sort((a, b) => a.index - b.index)
            seatList.innerHTML = rows.map(s => {
                const me = s.index === mySeat
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
            this.setStatus('Game starting…')
        } else if (isHost) {
            this.setStatus(`You're the host. ${joined} player${joined === 1 ? '' : 's'} in — start when ready.`)
        } else {
            this.setStatus('Waiting for the host to start…')
        }
    }
}

customElements.define('wc-game-room', GameRoom)
