import {
    htmlToElement
} from "./index.js"
import {
    dispatch,
    COMMANDS,
} from "../scripts/index.js";

//language=HTML
const DICE_HTML = /*html*/ `
<div id="dice" class="die">
    <div id="d1" class="dice-face">
        <div class="dice-dot" style="grid-row:2;grid-column:2;"></div>
    </div>
    <div id="d2" class="dice-face hidden">
        <div class="dice-dot"></div>
        <div class="dice-dot" style="grid-row:3;grid-column:3;"></div>
    </div>
    <div id="d3" class="dice-face hidden">
        <div class="dice-dot"></div>
        <div class="dice-dot" style="grid-row:2;grid-column:2;"></div>
        <div class="dice-dot" style="grid-row:3;grid-column:3;"></div>
    </div>
    <div id="d4" class="dice-face hidden">
        <div class="dice-dot"></div>
        <div class="dice-dot" style="grid-column:3;"></div>
        <div class="dice-dot" style="grid-row:3;"></div>
        <div class="dice-dot" style="grid-row:3;grid-column:3;"></div>
    </div>
    <div id="d5" class="dice-face hidden">
        <div class="dice-dot"></div>
        <div class="dice-dot" style="grid-column:3;"></div>
        <div class="dice-dot" style="grid-row:2;grid-column:2;"></div>
        <div class="dice-dot" style="grid-row:3;"></div>
        <div class="dice-dot" style="grid-row:3;grid-column:3;"></div>
    </div>
    <div id="d6" class="dice-face hidden">
        <div class="dice-dot"></div>
        <div class="dice-dot" style="grid-column:3;"></div>
        <div class="dice-dot" style="grid-row:2;"></div>
        <div class="dice-dot" style="grid-row:2;grid-column:3;"></div>
        <div class="dice-dot" style="grid-row:3;"></div>
        <div class="dice-dot" style="grid-row:3;grid-column:3;"></div>
    </div>
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
