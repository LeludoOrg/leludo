/**
 * In-process transport channel — the seam used by solo + local
 * pass-and-play (online play runs over the real network channel instead).
 *
 * The Channel sits between "client" (UI dispatching commands) and
 * "authority" (the command handler + reducer that owns truth). In-process
 * means both halves run in the same JS context with synchronous calls, so
 * this is a thin wrapper — it exists to hold the same Channel interface the
 * networked transport implements, which keeps the rest of the code
 * transport-agnostic and makes the seam easy to drive in tests.
 *
 * Contract:
 *   const channel = createInProcessChannel({ dispatch });
 *   channel.send(command);   // forward to authority
 *   channel.onEvents(handler); // receive events back
 *
 * The store dispatches commands synchronously and emits events
 * synchronously through its subscriber list, so send/onEvents map straight
 * onto dispatch/subscribe.
 */

import { dispatch, subscribe } from '../../state/game-store.js';
import { makeEventHub } from './event-hub.js';

export function createInProcessChannel() {
    const hub = makeEventHub('channel handler threw');
    subscribe((event) => hub.emit([event]));
    return {
        send(command) {
            return dispatch(command);
        },
        onEvents(handler) {
            return hub.subscribe(handler);
        },
    };
}
