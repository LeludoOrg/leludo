#!/usr/bin/env node
/**
 * Local multiplayer server — Node `ws` transport over the shared RoomEngine +
 * Admission. This is the dev + Playwright-e2e runtime. Production uses a
 * Cloudflare Durable Object wrapping the SAME modules (see server/cf/), so the
 * only thing that differs between local and prod is this ~transport shell.
 *
 * Usage:  node server/local-server.mjs [port]
 * Env:
 *   MAX_CONCURRENT_GAMES, MAX_GAMES_PER_DAY  — admission caps
 *   DEV_TEST_HOOKS=1                          — enable test-only deterministic
 *                                               hooks (seed + the __busy__ room).
 *                                               MUST be off in production.
 *
 * Connect URL (query params):
 *   ws://host:port/?room=CODE&session=SID&name=NAME&humans=2&bots=0&seed=1
 *   - room    : room code (private). Created on first connect, joined after.
 *   - session : reconnect key. Same session → same seat on refresh/drop.
 *   - name    : display name.
 *   - humans/bots/seed/persona : room config, read only when the room is created.
 */
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { Admission } from './admission.js';
import { RoomEngine } from './room-engine.js';
import { Matchmaker } from './matchmaker.js';
import { mintRoomCode } from '../scripts/room-code.js';

const PORT = Number(process.argv[2] || process.env.PORT || 8890);
const TEST_HOOKS = process.env.DEV_TEST_HOOKS === '1';

const admission = new Admission({
    maxConcurrentGames: process.env.MAX_CONCURRENT_GAMES ? Number(process.env.MAX_CONCURRENT_GAMES) : undefined,
    maxGamesPerDay: process.env.MAX_GAMES_PER_DAY ? Number(process.env.MAX_GAMES_PER_DAY) : undefined,
});

/** roomId -> { engine, socketsBySession: Map<sid, Set<ws>> } */
const rooms = new Map();

function safeSend(ws, msg) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function makeRoom(roomId, cfg) {
    const socketsBySession = new Map();

    const transport = {
        broadcast(msg) {
            for (const set of socketsBySession.values()) {
                for (const ws of set) safeSend(ws, msg);
            }
        },
        send(seat, msg) {
            const sid = engine.seats[seat]?.sessionId;
            if (!sid) return;
            const set = socketsBySession.get(sid);
            if (set) for (const ws of set) safeSend(ws, msg);
        },
        release() {
            admission.release(roomId);
            rooms.delete(roomId);
        },
    };

    const engine = new RoomEngine({
        roomId,
        size: cfg.size,
        seatPlan: cfg.seatPlan,
        autoStart: cfg.autoStart,
        seed: cfg.seed,
        graceMs: cfg.graceMs,
        transport,
    });

    const room = { engine, socketsBySession };
    rooms.set(roomId, room);
    return room;
}

function mintCode() {
    return mintRoomCode(code => rooms.has(code));
}

/** Attach an (already open) connection to a room and seat its player. */
function bindConnToRoom(conn, room) {
    conn.room = room;
    if (!room.socketsBySession.has(conn.sessionId)) room.socketsBySession.set(conn.sessionId, new Set());
    room.socketsBySession.get(conn.sessionId).add(conn.ws);
    const joined = room.engine.handleJoin(conn.sessionId, conn.name, conn.color);
    if (!joined.ok) safeSend(conn.ws, { t: 'error', error: joined.error });
}

// Public matchmaking: form a room for a batch of queued players (+ bots on fill).
const matchmaker = new Matchmaker({
    fillMs: process.env.MATCH_FILL_MS ? Number(process.env.MATCH_FILL_MS) : 20_000,
    formMatch(size, entries, withBots) {
        const code = mintCode();
        const verdict = admission.tryAdmit(code);
        if (!verdict.ok) {
            for (const e of entries) safeSend(e.ws, { t: 'busy', reason: verdict.reason });
            return;
        }
        const humans = entries.length;
        // Seat plan: matched humans take PLAYER seats (the first becomes host),
        // remaining seats are bots when bot-filling, else open human seats.
        const seatPlan = [0, 1, 2, 3].map(i => {
            if (i >= size) return null;
            if (i < humans) return 'PLAYER';
            return withBots ? 'BOT' : 'PLAYER';
        });
        // Public matches auto-start once everyone is seated (no host wait).
        const room = makeRoom(code, { size, seatPlan, autoStart: true });
        for (const e of entries) {
            safeSend(e.ws, { t: 'matched', room: code });
            bindConnToRoom(e.conn, room);
        }
    },
});

const httpServer = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
    }
    if (url.pathname === '/stats') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ...admission.stats(), rooms: rooms.size }));
        return;
    }
    res.writeHead(404);
    res.end('not found');
});

const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws, req) => {
    const q = new URL(req.url, 'http://localhost').searchParams;
    const sessionId = q.get('session') || `anon-${Math.random().toString(36).slice(2)}`;
    const name = q.get('name') || '';
    const mode = q.get('mode');
    const roomId = q.get('room') || 'default';
    // Preferred seat colour (0..3); the engine honours it when that seat is free.
    const colorRaw = q.get('color');
    const color = colorRaw == null || colorRaw === '' ? null : Number(colorRaw);

    // Per-connection state. `room` is null until bound (immediately for private
    // rooms, on match-form for public matchmaking).
    const conn = { ws, sessionId, name, color, room: null };

    // Test-only deterministic busy: exercises the client busy overlay without
    // depending on global counters (so it stays parallel-safe in CI).
    if (TEST_HOOKS && (roomId === '__busy__' || q.get('forceBusy') === '1')) {
        safeSend(ws, { t: 'busy', reason: 'BUSY_CONCURRENT' });
        ws.close();
        return;
    }

    if (mode === 'public') {
        // Public random match: join a per-size queue; bound when a match forms.
        const size = Math.max(2, clampSeats(q.get('size'), 2));
        conn.size = size;
        const res = matchmaker.enqueue({ id: sessionId, size, name, ws, conn });
        if (res.queued) safeSend(ws, { t: 'queued', size, waiting: res.waiting });
        // else: matched synchronously — formMatch already sent 'matched' + seated.
    } else {
        // Private room (by code): find or create, admit, bind immediately.
        let room = rooms.get(roomId);
        if (!room) {
            const verdict = admission.tryAdmit(roomId);
            if (!verdict.ok) {
                safeSend(ws, { t: 'busy', reason: verdict.reason });
                ws.close();
                return;
            }
            // `size` is the host's chosen seat count; `humans` is accepted as an
            // alias for the dev harness. The creator becomes host on join.
            const size = Math.max(2, clampSeats(q.get('size') ?? q.get('humans'), 2));
            room = makeRoom(roomId, {
                size,
                seed: TEST_HOOKS && q.get('seed') != null ? Number(q.get('seed')) : 1,
                graceMs: TEST_HOOKS && q.get('grace') != null ? Number(q.get('grace')) : undefined,
            });
        }
        bindConnToRoom(conn, room);
    }

    ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        if (msg.t === 'queue_cancel') {
            matchmaker.cancel(sessionId);
            safeSend(ws, { t: 'queue_left' });
            return;
        }
        if (!conn.room) return; // not seated in a room yet
        const { engine } = conn.room;
        switch (msg.t) {
            case 'roll': engine.handleRoll(sessionId); break;
            case 'move': engine.handleMove(sessionId, msg.token); break;
            case 'join': engine.handleJoin(sessionId, msg.name, msg.color); break;
            // host-only lobby controls (the engine enforces NOT_HOST / NOT_IN_LOBBY)
            case 'lobby_size': engine.handleSetSize(sessionId, msg.n); break;
            case 'lobby_seat': engine.handleSetSeat(sessionId, msg.seat, msg.seatType); break;
            case 'lobby_kick': engine.handleKick(sessionId, msg.seat); break;
            case 'lobby_start': engine.handleStart(sessionId); break;
            default: break;
        }
    });

    ws.on('close', () => {
        matchmaker.cancel(sessionId); // no-op if not queued
        if (!conn.room) return;
        const { engine, socketsBySession } = conn.room;
        const set = socketsBySession.get(sessionId);
        if (set) {
            set.delete(ws);
            if (set.size === 0) {
                socketsBySession.delete(sessionId);
                engine.handleDisconnect(sessionId);
            }
        }
    });
});

function clampSeats(raw, fallback) {
    const n = Number(raw);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(0, Math.min(4, Math.floor(n)));
}

httpServer.listen(PORT, () => {
    console.log(`Leludo multiplayer server on http://localhost:${PORT} (ws://localhost:${PORT})`);
    if (TEST_HOOKS) console.log('  DEV_TEST_HOOKS enabled (seed + __busy__ room)');
});
