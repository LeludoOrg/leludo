/**
 * God mode — localhost-only debug aid. Lets the user pick a pawn and
 * then a target cell to teleport that pawn anywhere on the board.
 * Bypasses dice / movability / turn logic. Pure debug — gated by
 * isGodModeAvailable() so it never ships to production users.
 */

import { getTokenElement } from "./render-logic.js";

const STORAGE_KEY = 'debug-god-mode';

let _enabled = false;
let _selection = null;

export function isGodModeAvailable() {
    // Capacitor's Android WebView serves the app from https://localhost by
    // default, so a pure hostname check would let god-mode leak into the
    // shipped APK. window.Capacitor.isNativePlatform() is injected by the
    // Capacitor runtime only inside the native shell — never in a browser.
    if (typeof window !== 'undefined' && window.Capacitor?.isNativePlatform?.()) {
        return false;
    }
    return location.hostname === 'localhost' || location.hostname === '127.0.0.1';
}

if (isGodModeAvailable()) {
    _enabled = localStorage.getItem(STORAGE_KEY) === 'true';
}

export function isGodModeEnabled() {
    return _enabled && isGodModeAvailable();
}

export function setGodModeEnabled(value) {
    if (!isGodModeAvailable()) return;
    _enabled = !!value;
    localStorage.setItem(STORAGE_KEY, String(_enabled));
    if (!_enabled) clearGodSelection();
}

export function getGodSelection() {
    return _selection;
}

export function setGodSelection(playerIndex, tokenIndex) {
    clearGodSelection();
    _selection = { playerIndex, tokenIndex };
    const el = getTokenElement(playerIndex, tokenIndex);
    if (el && el.children[0]) el.children[0].classList.add('god-selected');
}

export function clearGodSelection() {
    if (!_selection) return;
    const { playerIndex, tokenIndex } = _selection;
    const el = getTokenElement(playerIndex, tokenIndex);
    if (el && el.children[0]) el.children[0].classList.remove('god-selected');
    _selection = null;
}

/**
 * Translate a board cell id into the canonical track position for the
 * given player.
 *   h-X-Y  → -1 (home base, ownership forced to playerIndex by render)
 *   mN     → main-track position 0..50 derived from mark index
 *   pXsY   → home-stretch position 51..56 (Y=1..6); X is ignored
 *
 * Returns null for cells that aren't reachable by playerIndex
 * (e.g. m51 is on the board but unreachable as a track position for
 * the player whose entry mark it is).
 */
export function cellIdToPosition(cellId, playerIndex) {
    if (/^h-\d-\d$/.test(cellId)) return -1;
    const markMatch = cellId.match(/^m(\d+)$/);
    if (markMatch) {
        const mark = parseInt(markMatch[1], 10);
        const pos = (mark - 13 * playerIndex + 52) % 52;
        if (pos > 50) return null;
        return pos;
    }
    const stretchMatch = cellId.match(/^p\ds([1-6])$/);
    if (stretchMatch) {
        return 50 + parseInt(stretchMatch[1], 10);
    }
    return null;
}
