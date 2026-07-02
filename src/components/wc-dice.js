import {
    htmlToElement
} from "./index.js"
import {
    dispatch,
    COMMANDS,
} from "../scripts/index.js";
import { DIE_PIPS } from "../scripts/core/dice-faces.js";

// Generate the six dice faces from the shared pip layout.
const diceFace = (value) => {
    const dots = DIE_PIPS[value]
        .map(([r, c]) => `<div class="dice-dot" style="grid-row:${r};grid-column:${c};"></div>`)
        .join("");
    return `<div id="d${value}" class="dice-face${value === 1 ? '' : ' hidden'}">${dots}</div>`;
};

//language=HTML
const DICE_HTML = /*html*/ `
<div id="dice" class="die">
    ${[1, 2, 3, 4, 5, 6].map(diceFace).join("\n    ")}
</div>
`

class Dice extends HTMLElement {
    constructor() {
        super()
        this.dataset.active = "true"
        this._abort = null
    }

    connectedCallback() {
        if (!this.firstElementChild) {
            this.appendChild(htmlToElement(DICE_HTML))
        }
        // AbortController so the global space-to-roll keyup is removed on
        // disconnect instead of leaking one handler per re-created dice.
        this._abort = new AbortController()
        const { signal } = this._abort
        this.addEventListener("click", () => this.handleDiceClick(), { signal })
        document.addEventListener("keyup", ($event) => {
            if ($event.key === " ") {
                this.handleDiceClick()
            }
        }, { signal })
    }

    disconnectedCallback() {
        this._abort?.abort()
        this._abort = null
    }

    handleDiceClick() {
        if (this.dataset.active === "true") {
            dispatch({ type: COMMANDS.ROLL_DICE })
        }
    }
}

window.customElements.define("wc-dice", Dice)
