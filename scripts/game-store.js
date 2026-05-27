/**
 * Single source of truth for the game. Wraps the reducer, a command
 * handler, and a subscriber list.
 *
 * Phase C of the event-sourced refactor — replaces module-level globals
 * in scripts/game-events.js and routes every state change through one
 * choke point.
 *
 * The dispatcher accepts either a command object (handled by the
 * registered command handler) or a raw event (applied directly through
 * the reducer). Commands may be async — dispatch returns a Promise so
 * callers can await side effects like animations that the command
 * handler runs inline today. Phase D will pull those side effects out
 * into listeners.
 */

import { state, initialGameState } from './game-state.js';
import { reducer, EVENTS, applyEvents } from './game-reducer.js';

const listeners = new Set();
let commandHandler = null;

export function setCommandHandler(handler) {
    commandHandler = handler;
}

/**
 * Apply an event directly. Internal — the command handler uses this.
 * External callers should dispatch commands instead.
 */
export function emit(event) {
    reducer(state, event);
    for (const l of listeners) {
        try { l(event, state); } catch (e) { console.error('listener threw', e); }
    }
}

/**
 * Dispatch a command. The command handler may return events synchronously
 * or a promise of additional events (for animations / async side effects).
 *
 * @param {{type: string, [k: string]: any}} command
 * @returns {Promise<void>|void}
 */
export function dispatch(command) {
    if (!commandHandler) {
        throw new Error('No command handler registered');
    }
    const result = commandHandler(state, command, {}, emit);
    if (result && typeof result.then === 'function') {
        return result;
    }
}

export function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export { EVENTS, applyEvents, initialGameState };
