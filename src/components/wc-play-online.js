import { htmlToElement } from "./index.js";
import { playClickSound } from "../scripts/index.js";
import { ICON_BACK, ICON_GLOBE, ICON_CHEVRON, QUAD_CHIP_SVG } from "./wc-icons.js";
import { ROOM_CODE_CHARS, ROOM_CODE_LENGTH } from "../scripts/core/room-code.js";

// Strip anything a room code can't contain: upper-case, then keep only the
// canonical alphabet (no spaces, no ambiguous 0/O/1/I/L, no punctuation) and
// cap at the fixed length. One source of truth shared with the minter, so the
// field can never hold a code the server would reject.
function sanitizeCode(raw) {
    return [...(raw || '').toUpperCase()]
        .filter(c => ROOM_CODE_CHARS.includes(c))
        .join('')
        .slice(0, ROOM_CODE_LENGTH);
}

// The "Play online" entry screen: join a friend's room by code (the primary
// action) or create your own. It owns no socket and no identity — your name and
// colour are picked later, inside the room lobby (<wc-game-room>). It emits an
// `online-intent` ({kind:'create'|'join'|'back', code?}) that wc-quick-start
// (the net controller) acts on, navigating to <wc-game-room>.
class PlayOnline extends HTMLElement {
    connectedCallback() {
        const html = /*html*/ `
            <div class="frame">
                <div class="top-bar">
                    <button class="back-btn icon-btn">${ICON_BACK}</button>
                    <div class="top-bar-title">Play online</div>
                    <wc-settings></wc-settings>
                </div>

                <div class="frame-body online-setup-body">
                    <!-- Join is the primary path: most players arrive with a code a
                         friend shared. Hosting your own sits below as a quieter card. -->
                    <div class="online-join">
                        <span class="section-label">Join a friend&rsquo;s room</span>
                        <p class="online-join-lead">Enter the 4-character code they shared with you.</p>
                        <input class="online-code-input" data-testid="online-code-input" type="text" inputmode="latin" autocapitalize="characters" autocomplete="off" autocorrect="off" spellcheck="false" maxlength="4" placeholder="ENTER CODE" aria-label="Room code" />
                        <button class="online-join-btn cta-primary" data-testid="online-join">${ICON_GLOBE}<span>Join room</span></button>
                        <p class="online-status" data-testid="online-status"></p>
                    </div>

                    <div class="online-host-divider"><span>or host your own</span></div>

                    <button class="online-create-card" data-testid="online-create">
                        <span class="online-create-chip">${QUAD_CHIP_SVG(34)}</span>
                        <span class="online-create-text">Create a room</span>
                        <span class="online-create-chevron">${ICON_CHEVRON}</span>
                    </button>
                </div>
            </div>
        `

        const el = htmlToElement(html)

        el.querySelector(".back-btn").addEventListener("click", () => { playClickSound(); this._emit('back') })

        el.querySelector('[data-testid="online-create"]').addEventListener("click", () => {
            playClickSound()
            this._emit('create')
        })

        const codeInput = el.querySelector(".online-code-input")
        const doJoin = () => {
            const code = sanitizeCode(codeInput.value)
            if (code.length !== ROOM_CODE_LENGTH) {
                this.setStatus("Enter the 4-character room code your host shared.")
                codeInput.focus()
                return
            }
            playClickSound()
            this._emit('join', { code })
        }
        el.querySelector(".online-join-btn").addEventListener("click", doJoin)
        // Filter the field down to a valid code on every keystroke (strips spaces,
        // lower-case, and out-of-alphabet chars), then clear any prompt once the
        // player has typed something usable.
        codeInput.addEventListener("input", () => {
            const cleaned = sanitizeCode(codeInput.value)
            if (cleaned !== codeInput.value) codeInput.value = cleaned
            if (cleaned) this.setStatus("")
        })
        codeInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); doJoin() } })

        this.appendChild(el)
    }

    _emit(kind, detail = {}) {
        this.dispatchEvent(new CustomEvent('online-intent', { detail: { kind, ...detail }, bubbles: true }))
    }

    setStatus(text) {
        const el = this.querySelector('[data-testid="online-status"]')
        if (el) el.textContent = text
    }

    /** Toggle the "checking the code" state while a join is validated against the
     *  server: disable the input + button so the player can't double-submit, and
     *  show a status line. The controller (wc-quick-start) clears it on success
     *  (navigating into the room) or on an error message. */
    setChecking(on) {
        const btn = this.querySelector('.online-join-btn')
        const input = this.querySelector('.online-code-input')
        if (btn) btn.disabled = on
        if (input) input.disabled = on
        if (on) this.setStatus('Checking room…')
    }

    /** Arrived via a shared invite link without a saved name: drop the code into
     *  the join field so one tap joins the room (name + colour are picked in the
     *  lobby afterwards). */
    prefillJoin(code) {
        const c = sanitizeCode(code)
        const codeInput = this.querySelector('.online-code-input')
        if (codeInput) codeInput.value = c
        this.setStatus(`Tap Join to enter room ${c}.`)
        codeInput?.focus()
    }
}

customElements.define('wc-play-online', PlayOnline)
