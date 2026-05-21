/**
 * Mock-network channel — JSON-serializes every command and event hop so
 * the test suite catches non-serializable payloads early. Stands in for
 * a real WebSocket transport during development.
 *
 * Phase F of the event-sourced refactor. Pairs a client side (send
 * commands, receive events) with a server side (apply commands, broadcast
 * events) via synchronous JSON round-tripping. No real network involved.
 *
 * Use createMockNetworkPair({ applyCommand }) to get { client, server }.
 *   client.send(cmd)        — JSON-encodes cmd, hands to server
 *   client.onEvents(handler) — handler receives JSON round-tripped events
 *   server.broadcast(event)  — JSON-encodes event, hands to client
 *
 * applyCommand is the authority-side command handler — typically a
 * function that runs the command against a server-owned state and emits
 * events back through server.broadcast.
 */

function jsonRoundTrip(value) {
    return JSON.parse(JSON.stringify(value));
}

export function createMockNetworkPair({ applyCommand }) {
    const clientHandlers = new Set();

    const server = {
        broadcast(event) {
            const encoded = jsonRoundTrip(event);
            for (const h of clientHandlers) {
                try { h([encoded]); } catch (e) { console.error('client handler threw', e); }
            }
        },
    };

    const client = {
        send(command) {
            const encoded = jsonRoundTrip(command);
            return applyCommand(encoded, server);
        },
        onEvents(handler) {
            clientHandlers.add(handler);
            return () => clientHandlers.delete(handler);
        },
    };

    return { client, server };
}
