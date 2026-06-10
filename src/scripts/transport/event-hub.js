/**
 * Tiny pub/sub hub shared by the transport channels (in-process +
 * mock-network). Both keep a Set of event handlers and fan each event
 * batch out to all of them, isolating a throwing handler so one bad
 * subscriber can't starve the rest. This is the one source of truth for
 * that pattern.
 *
 *   const hub = makeEventHub('channel handler threw');
 *   const off = hub.subscribe((events) => { ... });
 *   hub.emit([event]);   // fans the batch out to every handler
 *   off();               // unsubscribe
 *
 * @param {string} [errorLabel]  prefix for the console.error when a
 *   handler throws — lets each channel keep its own diagnostic wording.
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
