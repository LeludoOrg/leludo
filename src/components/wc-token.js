import {
    htmlToElement
} from "./index.js"
import {
    dispatch,
    COMMANDS,
} from "../scripts/index.js";

//language=HTML
const TOKEN_HTML = (playerIndex) => /*html*/ `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"
         class="player-fg-${playerIndex}">
        <defs>
            <linearGradient id="pb${playerIndex}" x1="0.2" y1="0" x2="0.8" y2="1">
                <stop offset="0%" stop-color="white" stop-opacity="0.35"/>
                <stop offset="100%" stop-color="black" stop-opacity="0.12"/>
            </linearGradient>
            <radialGradient id="ph${playerIndex}" cx="0.4" cy="0.35" r="0.5">
                <stop offset="0%" stop-color="white" stop-opacity="0.45"/>
                <stop offset="100%" stop-color="white" stop-opacity="0"/>
            </radialGradient>
        </defs>
        <ellipse cx="50" cy="88" rx="30" ry="8" fill="currentColor"/>
        <ellipse cx="50" cy="88" rx="30" ry="8" fill="black" opacity="0.1"/>
        <path d="M32 85 Q30 70 36 55 Q40 45 42 38 L58 38 Q60 45 64 55 Q70 70 68 85 Z" fill="currentColor" stroke="white" stroke-width="1.5" stroke-opacity="0.5"/>
        <path d="M32 85 Q30 70 36 55 Q40 45 42 38 L58 38 Q60 45 64 55 Q70 70 68 85 Z" fill="url(#pb${playerIndex})"/>
        <ellipse cx="50" cy="38" rx="13" ry="4" fill="currentColor"/>
        <ellipse cx="50" cy="38" rx="13" ry="4" fill="white" opacity="0.15"/>
        <circle cx="50" cy="24" r="16" fill="currentColor" stroke="white" stroke-width="1.5" stroke-opacity="0.5"/>
        <circle cx="50" cy="24" r="16" fill="url(#ph${playerIndex})"/>
        <ellipse cx="44" cy="18" rx="5" ry="3.5" fill="white" opacity="0.4" transform="rotate(-20 44 18)"/>
    </svg>
`

class Token extends HTMLElement {
    static observedAttributes = ["id"]

    constructor() {
        super()
        this._playerIndex = NaN
        this._tokenIndex = NaN
        // One AbortController per connection drives listener cleanup so the
        // global keyup handler can't accumulate across re-created tokens.
        this._abort = null
    }

    /**
     *
     * @param {string} name
     * @param {string} oldValue
     * @param {string} newValue
     */
    attributeChangedCallback(name, oldValue, newValue) {
        if (name === "id") {
            const idTokens = newValue.split("-")
            this._playerIndex = +idTokens[1]
            this._tokenIndex = +idTokens[2]
            // replaceChildren (not appendChild) so re-assigning id re-renders
            // in place instead of stacking a second pawn SVG.
            this.replaceChildren(htmlToElement(TOKEN_HTML(this._playerIndex)))
        }
    }

    connectedCallback() {
        this._abort = new AbortController()
        document.addEventListener("keyup", ($event) => {
            if (!Number.isNaN(this._tokenIndex)
                && $event.key === (this._tokenIndex + 1).toString()) {
                this.handleTokenClick(this._playerIndex, this._tokenIndex)
            }
        }, { signal: this._abort.signal })
    }

    disconnectedCallback() {
        this._abort?.abort()
        this._abort = null
    }

    /**
     *
     * @param {number} playerIndex
     * @param {number} tokenIndex
     */
    handleTokenClick(playerIndex, tokenIndex) {
        const isTokenActive = this.children[0].classList.contains("animate-bounce");
        if (isTokenActive) {
            dispatch({ type: COMMANDS.SELECT_TOKEN, playerIndex, tokenIndex })
        }
    }
}

window.customElements.define("wc-token", Token)
