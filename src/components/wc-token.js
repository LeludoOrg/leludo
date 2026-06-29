import {
    htmlToElement
} from "./index.js"
import {
    dispatch,
    COMMANDS,
} from "../scripts/index.js";
import { pawnSVG } from "../scripts/render/pawn-shape.js";

// The on-board pawn is built from the shared pawn-shape builder so the glyph
// can't drift from the launch / capture / pawn-step overlays. `currentColor`
// (from the player-fg-N class) drives the fill; the dark outline / base disc
// derive from it, so runtime applyColorMap recolors the pawn for free. `fill`
// mode omits width/height — wc-token.css sizes the svg to its (possibly
// stacked) box.
const TOKEN_HTML = (playerIndex) =>
    pawnSVG('currentColor', null, `player-fg-${playerIndex}`, 'tok', { fill: true })

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
