/**
 * Minimal DOM fixture for the headless soak client.
 *
 * The soak harness boots the REAL browser client pipeline (net-client →
 * online-game → command-handler → game-reducer → render-logic) in a happy-dom
 * realm so it can compare each client's believed state against the server. The
 * command handler + render layer are state-driven (they never READ the DOM to
 * decide state — see command-handler.js), but they DO write to a handful of
 * fixed element ids and would throw if those nodes were missing. This fixture
 * pre-creates exactly those nodes so the real functions run unmodified.
 *
 * The node ids mirror what render-logic.js / command-handler.js touch:
 *   - showGame()            → #main-menu, #game
 *   - mountGameEnd()        → #game-container, #game, <wc-game-end>
 *   - resetGameDom()        → #turn-counter, #wc-dice, #dice-home
 *   - animateDiceRoll()     → #dice, #d1..#d6 (updateDiceFace)
 *   - activate/inactiveDice → #wc-dice
 *   - updateCornerWidgets() → b0..b3 (+ reparents #wc-dice)
 *   - mountTokensFromState()→ board cells: h-{p}-{t}, m{0..51}, p{p}s{1..6}
 *                             wrapped in .board-wrap (animateCaptureToHome /
 *                             playYardLaunch need a .board-wrap ancestor)
 *   - exitToHome()          → #pause-menu, #settings-overlay (guarded, cheap)
 *
 * Board-cell id scheme is owned by render-logic.getTokenContainerId(); the
 * ranges below (track 0..51, home-stretch s1..s6, 4×4 yards) are the board
 * geometry from core/board-constants.js (TRACK_LEN 52, HOME_STRETCH 51..56).
 */

const TRACK_MARKS = 52;       // m0..m51  (board-constants TRACK_LEN)
const HOME_SLOTS = 6;         // p{p}s1..s6 (positions 51..56 → safeIndex 1..6)
const PLAYERS = 4;
const TOKENS = 4;

/** Register trivial stand-ins for the web components the pipeline instantiates.
 *  We never load the real wc-board/wc-token/wc-game-end (heavy, DOM-coupled);
 *  these no-op shells satisfy `document.createElement('wc-token').children[0]`
 *  (activateToken) and the wc-game-end mount without pulling the real ones in. */
function defineStubElements(win) {
    const reg = win.customElements;
    if (!reg.get('wc-token')) {
        reg.define('wc-token', class extends win.HTMLElement {
            connectedCallback() {
                // activateToken() reaches for children[0] — give it an inner node.
                if (!this.children.length) this.appendChild(this.ownerDocument.createElement('div'));
            }
        });
    }
    if (!reg.get('wc-game-end')) {
        reg.define('wc-game-end', class extends win.HTMLElement {});
    }
}

/** The fixture markup as an HTML string — shared by the happy-dom worker boot
 *  (installDomFixture) and the in-browser harness page. Keeping it one source
 *  avoids the two fixtures drifting. */
export function fixtureHtml() {
    const cell = (id) => `<div id="${id}" class="cell"></div>`;
    const yards = [];
    for (let p = 0; p < PLAYERS; p++) for (let t = 0; t < TOKENS; t++) yards.push(cell(`h-${p}-${t}`));
    const ring = [];
    for (let m = 0; m < TRACK_MARKS; m++) ring.push(cell(`m${m}`));
    const home = [];
    for (let p = 0; p < PLAYERS; p++) for (let s = 1; s <= HOME_SLOTS; s++) home.push(cell(`p${p}s${s}`));
    const dice = [];
    for (let n = 1; n <= 6; n++) dice.push(`<div id="d${n}"></div>`);
    const corners = [];
    for (let i = 0; i < PLAYERS; i++) corners.push(`<div id="b${i}"></div>`);

    return `<div id="app">
  <div id="main-menu"></div>
  <div id="game">
    <div id="turn-counter"></div>
    <div id="dice-home"><div id="wc-dice"></div></div>
    <div id="dice">${dice.join('')}</div>
    <div id="game-container">
      ${corners.join('')}
      <div class="board-wrap">${yards.join('')}${ring.join('')}${home.join('')}</div>
    </div>
  </div>
  <div id="pause-menu" class="hidden"></div>
  <div id="settings-overlay" class="hidden"></div>
</div>`;
}

/**
 * Build the game DOM the real render path writes to. Idempotent — clears and
 * rebuilds #app so a recycled realm starts clean.
 * @param {Window} win  happy-dom window
 */
export function installDomFixture(win) {
    defineStubElements(win);
    const doc = win.document;
    if (!doc.body) doc.documentElement.appendChild(doc.createElement('body'));
    doc.body.innerHTML = fixtureHtml();
    return { app: doc.getElementById('app'), game: doc.getElementById('game') };
}
