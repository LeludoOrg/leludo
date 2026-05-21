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
    }

    /**
     *
     * @param {string} name
     * @param {string} oldValue
     * @param {string} newValue
     */
    attributeChangedCallback(name, oldValue, newValue) {
        if (name === "id") {

            const id = newValue;
            const idTokens = id.split("-")
            const playerIndex = +idTokens[1]
            const tokenIndex = +idTokens[2]
            let tokenHTML = TOKEN_HTML(playerIndex);
            const tokenElement = htmlToElement(tokenHTML)
            this.appendChild(tokenElement) // fixme: if triggered multiple time would cause issues

            document.addEventListener("keyup", ($event) =>  {
                if ($event.key === (+tokenIndex + 1).toString()) {
                    this.handleTokenClick(playerIndex, tokenIndex)
                }
            })
        }
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
