/**
 * Tiny pub/sub hub — shared test-helper used by the mock-network channel.
 * Keeps a Set of event handlers and fans each event batch out to all of them,
 * isolating a throwing handler so one bad subscriber can't starve the rest.
 *
 *   const hub = makeEventHub('channel handler threw');
 *   const off = hub.subscribe((events) => { ... });
 *   hub.emit([event]);   // fans the batch out to every handler
 *   off();               // unsubscribe
 *
 * @param {string} [errorLabel]  prefix for the console.error when a
 *   handler throws — lets the channel keep its own diagnostic wording.
 */
export function makeEventHub(errorLabel = 'event handler threw') {
    const handlers = new Set();
    return {
        emit(payload) {
            for (const h of handlers) {
                try { h(payload); } catch (e) { console.error(errorLabel, e); }
            }
        },
        subscribe(handler) {
            handlers.add(handler);
            return () => handlers.delete(handler);
        },
    };
}
