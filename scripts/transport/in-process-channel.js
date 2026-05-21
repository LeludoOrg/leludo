/**
 * In-process transport channel — the default for solo + local pass-and-play.
 *
 * Phase F of the event-sourced refactor. The Channel is the seam between
 * "client" (UI dispatching commands) and "authority" (the command handler
 * + reducer that owns truth). In-process means both halves run in the
 * same JS context with synchronous calls; later phases can swap in a
 * WebSocketChannel without touching the rest of the code.
 *
 * Contract:
 *   const channel = createInProcessChannel({ dispatch });
 *   channel.send(command);   // forward to authority
 *   channel.onEvents(handler); // receive events back
 *
 * The current store dispatches commands synchronously and emits events
 * synchronously through its subscriber list, so this channel is a thin
 * wrapper. It exists to lock in the interface that a real network
 * transport will implement.
 */

import { dispatch, subscribe } from '../game-store.js';

export function createInProcessChannel() {
    const eventHandlers = new Set();
    subscribe((event) => {
        for (const h of eventHandlers) {
            try { h([event]); } catch (e) { console.error('channel handler threw', e); }
        }
    });
    return {
        send(command) {
            return dispatch(command);
        },
        onEvents(handler) {
            eventHandlers.add(handler);
            return () => eventHandlers.delete(handler);
        },
    };
}
