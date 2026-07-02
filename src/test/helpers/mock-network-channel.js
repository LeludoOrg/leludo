/**
 * Mock-network channel — test helper that JSON-serializes every command
 * and event hop so the suite catches non-serializable payloads early.
 * Stands in for the real networked transport without any sockets.
 *
 * Pairs a client side (send commands, receive events) with a server side
 * (apply commands, broadcast events) via synchronous JSON round-tripping.
 * No real network involved.
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

import { makeEventHub } from './event-hub.js';

function jsonRoundTrip(value) {
    return JSON.parse(JSON.stringify(value));
}

export function createMockNetworkPair({ applyCommand }) {
    const hub = makeEventHub('client handler threw');

    const server = {
        broadcast(event) {
            hub.emit([jsonRoundTrip(event)]);
        },
    };

    const client = {
        send(command) {
            const encoded = jsonRoundTrip(command);
            return applyCommand(encoded, server);
        },
        onEvents(handler) {
            return hub.subscribe(handler);
        },
    };

    return { client, server };
}
