import {
    htmlToElement
} from "./index.js"
import {dispatch, COMMANDS, playClickSound} from "../scripts/index.js";

//language=HTML
const STAR_D = "M12 2.2l2.8 6.3 6.8.5-5.2 4.4 1.6 6.6L12 16.6l-6 3.4 1.6-6.6L2.4 9l6.8-.5z";

const CORNER_RIGHT_DOWN = `<polyline points="10 15 15 20 20 15"/><path d="M4 4h7a4 4 0 0 1 4 4v12"/>`;
const CORNER_UP_RIGHT = `<polyline points="15 14 20 9 15 4"/><path d="M4 20v-7a4 4 0 0 1 4-4h12"/>`;
const CORNER_DOWN_LEFT = `<polyline points="9 10 4 15 9 20"/><path d="M20 4v7a4 4 0 0 1-4 4H4"/>`;
const CORNER_LEFT_UP = `<polyline points="14 9 9 4 4 9"/><path d="M20 20h-7a4 4 0 0 1-4-4V4"/>`;

const entryCellSvg = (playerIndex, cornerInner) => `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="path-cell-entry-svg player-fg-${playerIndex}">${cornerInner}</svg>`;

const safeCellSvg = (playerIndex) => `
    <svg viewBox="0 0 24 24" class="path-cell-safe-svg"><path d="${STAR_D}" class="player-fill-${playerIndex}" opacity="0.85"/></svg>`;

//language=HTML
const BOARD_HTML = /*html*/ `
    <div class="board-frame">
        <!-- Top bar -->
        <div class="board-topbar">
            <button id="g-pause-btn" class="icon-btn">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
            </button>
            <div style="flex:1"></div>
            <div id="turn-counter" class="turn-counter">Turn 0</div>
            <div style="flex:1"></div>
            <button id="g-settings-btn" class="icon-btn">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15.5a3.5 3.5 0 100-7 3.5 3.5 0 000 7zM19.4 13.5a7.6 7.6 0 000-3l2-1.6-2-3.5-2.4.8a7.5 7.5 0 00-2.6-1.5l-.4-2.5h-4l-.4 2.5a7.5 7.5 0 00-2.6 1.5l-2.4-.8-2 3.5 2 1.6a7.6 7.6 0 000 3l-2 1.6 2 3.5 2.4-.8a7.5 7.5 0 002.6 1.5l.4 2.5h4l.4-2.5a7.5 7.5 0 002.6-1.5l2.4.8 2-3.5-2-1.6z"/></svg>
            </button>
        </div>

        <!-- Spacer pushes board to bottom -->
        <div class="board-spacer"></div>

        <!-- Hidden home for wc-dice when no active corner has it yet -->
        <div id="dice-home" class="hidden"><wc-dice id="wc-dice"></wc-dice></div>

        <!-- Top corner row (seats 0/1) -->
        <div id="corner-row-top" class="board-corner-row">
            <div id="b0"></div>
            <div id="b1"></div>
        </div>

        <!-- Board -->
        <div class="board-area">
            <div class="board-wrap">
                <div class="board-grid">

                    <div class="home-quad home-quad--tl player-bg-0">
                        <div class="home-quad-slots player-bg-soft-0">
                            <div class="home-slot-cell"><div id="h-0-0" class="home-slot-dot player-border-0"></div></div>
                            <div class="home-slot-cell"><div id="h-0-1" class="home-slot-dot player-border-0"></div></div>
                            <div class="home-slot-cell"><div id="h-0-2" class="home-slot-dot player-border-0"></div></div>
                            <div class="home-slot-cell"><div id="h-0-3" class="home-slot-dot player-border-0"></div></div>
                        </div>
                    </div>

                    <div class="path-arm-v">
                        <div id="m10" class="path-cell"></div>
                        <div id="m11" class="path-cell path-cell--entry">${entryCellSvg(1, CORNER_RIGHT_DOWN)}</div>
                        <div id="m12" class="path-cell"></div>
                        <div id="m9" class="path-cell"></div>
                        <div id="p1s1" class="path-cell player-bg-path-1"></div>
                        <div id="m13" class="path-cell player-bg-path-1"></div>
                        <div id="m8" class="path-cell path-cell--safe">${safeCellSvg(1)}</div>
                        <div id="p1s2" class="path-cell player-bg-path-1"></div>
                        <div id="m14" class="path-cell"></div>
                        <div id="m7" class="path-cell"></div>
                        <div id="p1s3" class="path-cell player-bg-path-1"></div>
                        <div id="m15" class="path-cell"></div>
                        <div id="m6" class="path-cell"></div>
                        <div id="p1s4" class="path-cell player-bg-path-1"></div>
                        <div id="m16" class="path-cell"></div>
                        <div id="m5" class="path-cell"></div>
                        <div id="p1s5" class="path-cell player-bg-path-1"></div>
                        <div id="m17" class="path-cell"></div>
                    </div>

                    <div class="home-quad home-quad--tr player-bg-1">
                        <div class="home-quad-slots player-bg-soft-1">
                            <div class="home-slot-cell"><div id="h-1-0" class="home-slot-dot player-border-1"></div></div>
                            <div class="home-slot-cell"><div id="h-1-1" class="home-slot-dot player-border-1"></div></div>
                            <div class="home-slot-cell"><div id="h-1-2" class="home-slot-dot player-border-1"></div></div>
                            <div class="home-slot-cell"><div id="h-1-3" class="home-slot-dot player-border-1"></div></div>
                        </div>
                    </div>

                    <div class="path-arm-h">
                        <div id="m51" class="path-cell"></div>
                        <div id="m0" class="path-cell player-bg-path-0"></div>
                        <div id="m1" class="path-cell"></div>
                        <div id="m2" class="path-cell"></div>
                        <div id="m3" class="path-cell"></div>
                        <div id="m4" class="path-cell"></div>
                        <div id="m50" class="path-cell path-cell--entry">${entryCellSvg(0, CORNER_UP_RIGHT)}</div>
                        <div id="p0s1" class="path-cell player-bg-path-0"></div>
                        <div id="p0s2" class="path-cell player-bg-path-0"></div>
                        <div id="p0s3" class="path-cell player-bg-path-0"></div>
                        <div id="p0s4" class="path-cell player-bg-path-0"></div>
                        <div id="p0s5" class="path-cell player-bg-path-0"></div>
                        <div id="m49" class="path-cell"></div>
                        <div id="m48" class="path-cell"></div>
                        <div id="m47" class="path-cell path-cell--safe">${safeCellSvg(0)}</div>
                        <div id="m46" class="path-cell"></div>
                        <div id="m45" class="path-cell"></div>
                        <div id="m44" class="path-cell"></div>
                    </div>

                    <div class="finish-zone">
                        <div id="p0s6" class="finish-tri finish-tri--tl player-bg-path-0"></div>
                        <div id="p1s6" class="finish-tri finish-tri--tr player-bg-path-1"></div>
                        <div id="p3s6" class="finish-tri finish-tri--br player-bg-path-3"></div>
                        <div id="p2s6" class="finish-tri finish-tri--bl player-bg-path-2"></div>
                    </div>

                    <div class="path-arm-h">
                        <div id="m18" class="path-cell"></div>
                        <div id="m19" class="path-cell"></div>
                        <div id="m20" class="path-cell"></div>
                        <div id="m21" class="path-cell path-cell--safe">${safeCellSvg(2)}</div>
                        <div id="m22" class="path-cell"></div>
                        <div id="m23" class="path-cell"></div>
                        <div id="p2s5" class="path-cell player-bg-path-2"></div>
                        <div id="p2s4" class="path-cell player-bg-path-2"></div>
                        <div id="p2s3" class="path-cell player-bg-path-2"></div>
                        <div id="p2s2" class="path-cell player-bg-path-2"></div>
                        <div id="p2s1" class="path-cell player-bg-path-2"></div>
                        <div id="m24" class="path-cell path-cell--entry">${entryCellSvg(2, CORNER_DOWN_LEFT)}</div>
                        <div id="m30" class="path-cell"></div>
                        <div id="m29" class="path-cell"></div>
                        <div id="m28" class="path-cell"></div>
                        <div id="m27" class="path-cell"></div>
                        <div id="m26" class="path-cell player-bg-path-2"></div>
                        <div id="m25" class="path-cell"></div>
                    </div>

                    <div class="home-quad home-quad--bl player-bg-3">
                        <div class="home-quad-slots player-bg-soft-3">
                            <div class="home-slot-cell"><div id="h-3-0" class="home-slot-dot player-border-3"></div></div>
                            <div class="home-slot-cell"><div id="h-3-1" class="home-slot-dot player-border-3"></div></div>
                            <div class="home-slot-cell"><div id="h-3-2" class="home-slot-dot player-border-3"></div></div>
                            <div class="home-slot-cell"><div id="h-3-3" class="home-slot-dot player-border-3"></div></div>
                        </div>
                    </div>

                    <div class="path-arm-v">
                        <div id="m43" class="path-cell"></div>
                        <div id="p3s5" class="path-cell player-bg-path-3"></div>
                        <div id="m31" class="path-cell"></div>
                        <div id="m42" class="path-cell"></div>
                        <div id="p3s4" class="path-cell player-bg-path-3"></div>
                        <div id="m32" class="path-cell"></div>
                        <div id="m41" class="path-cell"></div>
                        <div id="p3s3" class="path-cell player-bg-path-3"></div>
                        <div id="m33" class="path-cell"></div>
                        <div id="m40" class="path-cell"></div>
                        <div id="p3s2" class="path-cell player-bg-path-3"></div>
                        <div id="m34" class="path-cell path-cell--safe">${safeCellSvg(3)}</div>
                        <div id="m39" class="path-cell player-bg-path-3"></div>
                        <div id="p3s1" class="path-cell player-bg-path-3"></div>
                        <div id="m35" class="path-cell"></div>
                        <div id="m38" class="path-cell"></div>
                        <div id="m37" class="path-cell path-cell--entry">${entryCellSvg(3, CORNER_LEFT_UP)}</div>
                        <div id="m36" class="path-cell"></div>
                    </div>

                    <div class="home-quad home-quad--br player-bg-2">
                        <div class="home-quad-slots player-bg-soft-2">
                            <div class="home-slot-cell"><div id="h-2-0" class="home-slot-dot player-border-2"></div></div>
                            <div class="home-slot-cell"><div id="h-2-1" class="home-slot-dot player-border-2"></div></div>
                            <div class="home-slot-cell"><div id="h-2-2" class="home-slot-dot player-border-2"></div></div>
                            <div class="home-slot-cell"><div id="h-2-3" class="home-slot-dot player-border-2"></div></div>
                        </div>
                    </div>

                </div>
            </div>
        </div>

        <!-- Bottom corner row (seats 3/2) -->
        <div id="corner-row-bottom" class="board-corner-row board-corner-row--bottom">
            <div id="b3"></div>
            <div id="b2"></div>
        </div>

        <!-- Spacer balances the top one so the board sits vertically centered -->
        <div class="board-spacer"></div>
    </div>
`

class Board extends HTMLElement {
    constructor() {
        super()
    }

    connectedCallback() {
        const boardElement = htmlToElement(BOARD_HTML)

        boardElement.querySelector("#g-pause-btn").addEventListener("click", () => {
            playClickSound()
            dispatch({ type: COMMANDS.PAUSE })
        })

        const cellIdPattern = /^(h-\d-\d|m\d+|p\ds[1-6])$/;
        boardElement.querySelectorAll('[id^="h-"], [id^="m"], [id^="p"][id*="s"]').forEach((cell) => {
            if (!cellIdPattern.test(cell.id)) return;
            cell.addEventListener("click", () => {
                const activeInner = cell.querySelector(':scope > wc-token > .animate-bounce');
                if (!activeInner) return;
                const token = activeInner.parentElement;
                const parts = token.id.split('-');
                const playerIndex = +parts[1];
                const tokenIndex = +parts[2];
                playClickSound();
                dispatch({ type: COMMANDS.SELECT_TOKEN, playerIndex, tokenIndex });
            });
        });

        this.appendChild(boardElement)
    }
}

window.customElements.define("wc-board", Board)
