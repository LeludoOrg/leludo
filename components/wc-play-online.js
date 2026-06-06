import { htmlToElement } from "./index.js";
import { playClickSound, escapeHtml } from "../scripts/index.js";
import { getSavedSeatName } from "../scripts/bot-names.js";
import { getUsername, setUsername } from "../scripts/net-client.js";
import { ICON_BACK, ICON_PLUS, ICON_PENCIL, PAWN_SVG } from "./wc-icons.js";

// The "Play online" setup screen: pick your name, then either join a friend's
// room by code or create your own. It owns no socket — it validates the name
// and emits an `online-intent` ({kind:'create'|'join'|'back', code?}) that
// wc-quick-start (the net controller) acts on, navigating to <wc-game-room>.
// Seats and bots are managed later, in the room, so there are no Open/Bot
// toggles here — only the host's name input.
class PlayOnline extends HTMLElement {
    connectedCallback() {
        // Remembered username; fall back to the offline seat name as a suggestion.
        const savedName = (getUsername() || getSavedSeatName('PLAYER', 0) || '').slice(0, 12)

        const html = /*html*/ `
            <div class="frame">
                <div class="top-bar">
                    <button class="back-btn icon-btn">${ICON_BACK}</button>
                    <div class="top-bar-title">Play online</div>
                    <wc-settings></wc-settings>
                </div>

                <div class="frame-body online-setup-body">
                    <!-- Identity hero: your name, centered — mirrors the home
                         screen's centered die + title so the transition feels
                         continuous. The actions sit at the bottom like home's CTAs. -->
                    <div class="online-identity" data-testid="online-setup-seat-0">
                        <div class="online-identity-pawn" style="background:hsl(var(--player-0));">
                            <div class="seat-pawn">${PAWN_SVG(0)}</div>
                        </div>
                        <label class="seat-name-wrap online-identity-name">
                            <input class="seat-name" data-testid="online-name" type="text" name="ludo-online-name" autocomplete="off" autocorrect="off" autocapitalize="words" data-form-type="other" data-lpignore="true" data-1p-ignore="true" style="caret-color:hsl(var(--player-0));" value="${escapeHtml(savedName)}" maxlength="12" spellcheck="false" placeholder="Your name" />
                            <span class="seat-name-pencil">${ICON_PENCIL}</span>
                        </label>
                        <p class="online-identity-hint">This is you. Tap to rename.</p>
                    </div>

                    <p class="online-status" data-testid="online-status"></p>
                </div>

                <div class="frame-footer online-actions">
                    <div class="online-join-row">
                        <input class="online-code-input" data-testid="online-code-input" type="text" inputmode="latin" autocapitalize="characters" autocomplete="off" autocorrect="off" spellcheck="false" maxlength="6" placeholder="ENTER CODE" />
                        <button class="online-join-btn cta-secondary" data-testid="online-join">Join</button>
                    </div>
                    <div class="online-divider online-new-room-divider"><span>or</span></div>
                    <button class="online-create-btn cta-primary" data-testid="online-create">${ICON_PLUS}<span>Create room</span></button>
                </div>
            </div>
        `

        const el = htmlToElement(html)

        el.querySelector(".back-btn").addEventListener("click", () => { playClickSound(); this._emit('back') })

        const nameInput = el.querySelector('[data-testid="online-name"]')
        // Remember the name as it's typed and clear any "enter a name" prompt.
        nameInput.addEventListener("input", () => {
            const v = (nameInput.value || '').trim()
            if (v) { setUsername(v); this.setStatus("") }
        })
        nameInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); nameInput.blur() } })

        el.querySelector('[data-testid="online-create"]').addEventListener("click", () => {
            if (!this._requireName()) return
            playClickSound()
            this._emit('create')
        })

        const codeInput = el.querySelector(".online-code-input")
        const doJoin = () => {
            if (!this._requireName()) return
            const code = (codeInput.value || '').trim().toUpperCase()
            if (code.length < 4) {
                this.setStatus("Enter the 4-letter room code your host shared.")
                codeInput.focus()
                return
            }
            playClickSound()
            this._emit('join', { code })
        }
        el.querySelector(".online-join-btn").addEventListener("click", doJoin)
        codeInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); doJoin() } })

        this.appendChild(el)
    }

    /** Require a non-empty name before going online; remember it. Returns the
     *  trimmed name, or null (and prompts) when empty. */
    _requireName() {
        const input = this.querySelector('[data-testid="online-name"]')
        const name = (input?.value || '').trim()
        if (!name) {
            this.setStatus('Enter a name to play online.')
            input?.focus()
            return null
        }
        setUsername(name)
        return name
    }

    _emit(kind, detail = {}) {
        this.dispatchEvent(new CustomEvent('online-intent', { detail: { kind, ...detail }, bubbles: true }))
    }

    setStatus(text) {
        const el = this.querySelector('[data-testid="online-status"]')
        if (el) el.textContent = text
    }
}

customElements.define('wc-play-online', PlayOnline)
