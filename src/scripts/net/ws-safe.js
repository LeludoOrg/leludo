/**
 * Runtime-agnostic WebSocket safety helpers, shared by the browser client and
 * both transports (Node `ws`, CF Worker sockets). All three deliver string
 * frames and expose `.close()`, so the parse-or-drop and close-without-throwing
 * idioms — copy-pasted across net-client, the Durable Objects, and the local
 * dev server — live here once. Uses only JSON + optional chaining, so it loads
 * unchanged in the browser, Node, and a Worker.
 */

/** JSON.parse that returns null instead of throwing on a malformed frame. */
export function safeParse(data) {
    try { return JSON.parse(data); } catch { return null; }
}

/** Close a socket, swallowing the throw when it's already gone. Null-safe, so
 *  `safeClose(maybeSocket)` is fine. `code`/`reason` are forwarded when given. */
export function safeClose(ws, code, reason) {
    try { ws?.close(code, reason); } catch { /* already gone */ }
}
