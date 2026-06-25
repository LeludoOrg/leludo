/**
 * Single source of truth for the multiplayer wire protocol.
 *
 * Every socket frame is `{ t, ... }`. Broadcast frames (state / moved /
 * dropped / ended) also carry `seq`, a per-room monotonic counter stamped by
 * the RoomEngine — clients drop frames whose seq they have already applied
 * (duplicate delivery via a zombie socket racing a reconnect) and skip
 * animations while replaying a backlog (only the newest frame animates).
 *
 * These enums name every `t` value, every `reason` code, and every
 * rejection/error code that crosses the wire. They are
 * imported by the browser client (net-client, online-game, wc-quick-start), the
 * runtime-agnostic engine (room-engine, matchmaker, admission), and the
 * Cloudflare Durable Objects (room-do, match-do, worker) that back both prod and
 * dev/e2e (the latter under `wrangler dev`). Client and server type these
 * independently, so a bare-string typo
 * would silently desync them — import the constants instead of re-typing.
 *
 * Plain ESM with no dependencies, so it loads in the browser, Node and the
 * Cloudflare Workers runtime alike.
 */

/** `t` — the frame type on every socket message. */
export const MSG = Object.freeze({
    // client → server intents
    JOIN: 'join',
    ROLL: 'roll',
    MOVE: 'move',
    // explicit forfeit: the player confirmed "Leave game" in the exit dialog.
    // Unlike a plain socket drop (which starts the reconnect grace), this tells
    // the server to free the seat NOW instead of waiting out the grace window.
    LEAVE: 'leave',
    // keepalive: an idle WebSocket (a player waiting through others' turns) has
    // no traffic, so Cloudflare's edge / NATs / proxies reap it after ~60-100s —
    // a silent drop with no real network fault. The client sends this on an
    // interval to keep the single TCP connection warm in BOTH directions. The
    // server treats it as a no-op (see dispatchIntent).
    PING: 'ping',
    LOBBY_SIZE: 'lobby_size',
    LOBBY_SEAT: 'lobby_seat',
    LOBBY_KICK: 'lobby_kick',
    LOBBY_START: 'lobby_start',
    // a seated player sets their OWN name and/or colour (open-seat move) in the
    // lobby — picked there now instead of on the Play Online setup screen.
    LOBBY_PROFILE: 'lobby_profile',
    QUEUE_CANCEL: 'queue_cancel',
    // server → client broadcasts
    SEATED: 'seated',
    STATE: 'state',
    MOVED: 'moved',
    DROPPED: 'dropped',
    ENDED: 'ended',
    KICKED: 'kicked',
    REJECTED: 'rejected',
    ERROR: 'error',
    // matchmaking
    BUSY: 'busy',
    MATCHED: 'matched',
    QUEUED: 'queued',
    QUEUE_LEFT: 'queue_left',
});

/**
 * `reason` — why a `moved` frame resolved the turn, or why a `state` / `ended`
 * frame fired (a player left or the game is over).
 */
export const REASON = Object.freeze({
    // turn-resolution reasons on a `moved`/`state` frame
    ROLLED: 'rolled',
    NO_MOVE: 'no-move',
    THREE_SIXES: 'three-sixes',
    // game-over reasons on an `ended` frame
    OPPONENT_LEFT: 'opponent-left',
    ABANDONED: 'abandoned',
    NO_ACTIVE_PLAYERS: 'no-active-players',
    FINISHED: 'finished',
    // informational reasons tagging why a `state` snapshot was broadcast
    RECONNECT: 'reconnect',
    JOIN: 'join',
    LOBBY: 'lobby',
    DISCONNECT: 'disconnect',
    WAITING: 'waiting',
    TURN: 'turn',
    AGAIN: 'again',
});

/** `error` — rejection codes the server sends on a `rejected` / `error` frame. */
export const ERR = Object.freeze({
    // A join-by-code hit a room that was never created (no host). The server
    // refuses to silently auto-create it, so a typo'd / stale code is rejected
    // instead of dropping the player into an empty ghost room.
    ROOM_NOT_FOUND: 'ROOM_NOT_FOUND',
    ROOM_FULL: 'ROOM_FULL',
    NOT_SEATED: 'NOT_SEATED',
    NOT_HOST: 'NOT_HOST',
    NOT_YOUR_TURN: 'NOT_YOUR_TURN',
    ILLEGAL_MOVE: 'ILLEGAL_MOVE',
    NOT_AWAITING_ROLL: 'NOT_AWAITING_ROLL',
    NOT_AWAITING_MOVE: 'NOT_AWAITING_MOVE',
    NOT_IN_LOBBY: 'NOT_IN_LOBBY',
    BAD_SEAT: 'BAD_SEAT',
    BAD_TYPE: 'BAD_TYPE',
    CANT_CHANGE_HOST: 'CANT_CHANGE_HOST',
    CANT_KICK_HOST: 'CANT_KICK_HOST',
    CANT_SHRINK: 'CANT_SHRINK',
    MIN_TWO: 'MIN_TWO',
    NEED_TWO_PLAYERS: 'NEED_TWO_PLAYERS',
    NOTHING_TO_KICK: 'NOTHING_TO_KICK',
    NOT_A_HUMAN_SEAT: 'NOT_A_HUMAN_SEAT',
});

/** Admission-gate reasons, sent on a `busy` frame. */
export const BUSY = Object.freeze({
    CONCURRENT: 'BUSY_CONCURRENT',
    DAILY: 'BUSY_DAILY',
});
