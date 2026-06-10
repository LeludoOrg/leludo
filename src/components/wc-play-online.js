import { htmlToElement } from "./index.js";
import { playClickSound, escapeHtml } from "../scripts/index.js";
import { getSavedSeatName } from "../scripts/core/bot-names.js";
import { getUsername, setUsername, getOnlineColor, setOnlineColor } from "../scripts/net/net-client.js";
import { ICON_BACK, ICON_PLUS, ICON_PENCIL } from "./wc-icons.js";

// Tiles laid out like the logo: top-left, top-right, bottom-left, bottom-right
// map to player colours 1, 2, 3, 0. Each tile's value is the colour index,
// which doubles as the requested seat index the server seats you into.
const TILE_ORDER = [1, 2, 3, 0];

// The "Play online" setup screen: pick your colour + name, then join a friend's
// room by code or create your own. It owns no socket — it remembers the colour
// (getOnlineColor/setOnlineColor), which the controller forwards as the HOST's
// preferred seat when you CREATE a room (a joiner takes whatever seat the server
// assigns). It emits an `online-intent` ({kind:'create'|'join'|'back', code?})
// that wc-quick-start (the net controller) acts on, navigating to <wc-game-room>.
class PlayOnline extends HTMLElement {
    connectedCallback() {
        // Remembered username; fall back to the offline seat name as a suggestion.
        const savedName = (getUsername() || getSavedSeatName('PLAYER', 0) || '').slice(0, 12)
        const color = getOnlineColor()

        const tiles = TILE_ORDER.map(c => /*html*/ `
            <button class="online-color-tile${c === color ? ' is-selected' : ''}" type="button"
                    data-color="${c}" data-testid="online-color-${c}"
                    aria-label="Colour ${c + 1}" aria-pressed="${c === color}"
                    style="--tile:hsl(var(--player-${c}));"></button>`).join('')

        const html = /*html*/ `
            <div class="frame">
                <div class="top-bar">
                    <button class="back-btn icon-btn">${ICON_BACK}</button>
                    <div class="top-bar-title">Play online</div>
                    <wc-settings></wc-settings>
                </div>

                <div class="frame-body online-setup-body">
                    <!-- Identity hero: your colour + name, centered — mirrors the
                         home screen's centered die + title so the transition feels
                         continuous. The actions sit at the bottom like home's CTAs. -->
                    <div class="online-identity" data-testid="online-setup-seat-0">
                        <div class="online-color-picker" role="group" aria-label="Pick your colour" data-testid="online-color-picker">
                            ${tiles}
                        </div>
                        <label class="seat-name-wrap online-identity-name">
                            <input class="seat-name" data-testid="online-name" type="text" name="ludo-online-name" autocomplete="off" autocorrect="off" autocapitalize="words" data-form-type="other" data-lpignore="true" data-1p-ignore="true" style="caret-color:hsl(var(--player-${color}));" value="${escapeHtml(savedName)}" maxlength="12" spellcheck="false" placeholder="Your name" />
                            <span class="seat-name-pencil">${ICON_PENCIL}</span>
                        </label>
                        <p class="online-identity-hint">Pick your colour and name to host a room &mdash; or join a friend&rsquo;s below.</p>
                    </div>

                    <p class="online-status" data-testid="online-status"></p>
                </div>

                <div class="frame-footer online-actions">
                    <button class="online-create-btn cta-primary" data-testid="online-create">${ICON_PLUS}<span>Create room</span></button>
                    <div class="online-divider online-new-room-divider"><span>or</span></div>
                    <div class="online-join-row">
                        <input class="online-code-input" data-testid="online-code-input" type="text" inputmode="latin" autocapitalize="characters" autocomplete="off" autocorrect="off" spellcheck="false" maxlength="6" placeholder="ENTER CODE" />
                        <button class="online-join-btn cta-secondary" data-testid="online-join">Join</button>
                    </div>
                </div>
            </div>
        `

        const el = htmlToElement(html)

        el.querySelector(".back-btn").addEventListener("click", () => { playClickSound(); this._emit('back') })

        // Colour picker: tapping a tile remembers it (sent as a preferred seat at
        // connect) and retints the name caret to match.
        el.querySelector('[data-testid="online-color-picker"]').addEventListener("click", (e) => {
            const tile = e.target.closest('.online-color-tile')
            if (!tile) return
            const c = Number(tile.dataset.color)
            if (c === getOnlineColor()) return
            playClickSound()
            setOnlineColor(c)
            this._selectColor(c)
        })

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

    /** Reflect the picked colour in the tiles + the name caret. */
    _selectColor(c) {
        this.querySelectorAll('.online-color-tile').forEach(t => {
            const on = Number(t.dataset.color) === c
            t.classList.toggle('is-selected', on)
            t.setAttribute('aria-pressed', String(on))
        })
        const input = this.querySelector('[data-testid="online-name"]')
        if (input) input.style.caretColor = `hsl(var(--player-${c}))`
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

    /** Arrived via a shared invite link without a saved name: drop the code into
     *  the join field and prompt for a name so one tap joins the room. */
    prefillJoin(code) {
        const c = (code || '').trim().toUpperCase()
        const codeInput = this.querySelector('.online-code-input')
        if (codeInput) codeInput.value = c
        this.setStatus(`Enter your name to join room ${c}.`)
        const name = this.querySelector('[data-testid="online-name"]')
        if (name) name.focus()
    }
}

customElements.define('wc-play-online', PlayOnline)
