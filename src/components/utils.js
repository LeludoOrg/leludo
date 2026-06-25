import { playClickSound } from "../scripts/render/audio.js";

/**
 *
 * @param {string} html
 * @returns {DocumentFragment}
 */
export function htmlToElement(html) {
    const element = document.createElement('template')
    element.innerHTML = html
    return element.content
}

/** Wire a click that plays the UI click sound, then runs `fn`. Collapses the
 *  `() => { playClickSound(); fn() }` listener repeated across the buttons that
 *  do nothing but chime + fire one action. */
export function onClickSound(node, fn) {
    node.addEventListener("click", () => { playClickSound(); fn(); });
}

/** Dispatch a bubbling CustomEvent carrying `{ kind, ...detail }` — the shared
 *  intent-event shape behind wc-game-room / wc-play-online's `_emit`. Each
 *  component keeps its own event name; the envelope shape lives here once. */
export function emitIntent(target, eventName, kind, detail = {}) {
    target.dispatchEvent(new CustomEvent(eventName, { detail: { kind, ...detail }, bubbles: true }));
}
