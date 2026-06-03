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

function buildPlayerTypes(humans, bots) {
    const types = [undefined, undefined, undefined, undefined];
    let i = 0;
    for (let h = 0; h < humans && i < 4; h++, i++) types[i] = 'PLAYER';
    for (let b = 0; b < bots && i < 4; b++, i++) types[i] = 'BOT';
    return types;
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
            // seat -> session(s) via the engine's seat map, then session -> sockets.
            for (const [sid, s] of engine.seatBySession) {
                if (s !== seat) continue;
                const set = socketsBySession.get(sid);
                if (set) for (const ws of set) safeSend(ws, msg);
            }
        },
        release() {
            admission.release(roomId);
            rooms.delete(roomId);
        },
    };

    const engine = new RoomEngine({
        roomId,
        playerTypes: buildPlayerTypes(cfg.humans, cfg.bots),
        seed: cfg.seed,
        transport,
    });

    const room = { engine, socketsBySession };
    rooms.set(roomId, room);
    return room;
}

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
    const roomId = q.get('room') || 'default';
    const sessionId = q.get('session') || `anon-${Math.random().toString(36).slice(2)}`;
    const name = q.get('name') || '';

    // Test-only deterministic busy: exercises the client busy overlay without
    // depending on global counters (so it stays parallel-safe in CI).
    if (TEST_HOOKS && (roomId === '__busy__' || q.get('forceBusy') === '1')) {
        safeSend(ws, { t: 'busy', reason: 'BUSY_CONCURRENT' });
        ws.close();
        return;
    }

    let room = rooms.get(roomId);
    if (!room) {
        const verdict = admission.tryAdmit(roomId);
        if (!verdict.ok) {
            safeSend(ws, { t: 'busy', reason: verdict.reason });
            ws.close();
            return;
        }
        room = makeRoom(roomId, {
            humans: clampSeats(q.get('humans'), 2),
            bots: clampSeats(q.get('bots'), 0),
            seed: TEST_HOOKS && q.get('seed') != null ? Number(q.get('seed')) : 1,
        });
    }

    const { engine, socketsBySession } = room;
    if (!socketsBySession.has(sessionId)) socketsBySession.set(sessionId, new Set());
    socketsBySession.get(sessionId).add(ws);

    const joined = engine.handleJoin(sessionId, name);
    if (!joined.ok) {
        safeSend(ws, { t: 'error', error: joined.error });
        ws.close();
        return;
    }

    ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        switch (msg.t) {
            case 'roll': engine.handleRoll(sessionId); break;
            case 'move': engine.handleMove(sessionId, msg.token); break;
            case 'join': engine.handleJoin(sessionId, msg.name); break;
            default: break;
        }
    });

    ws.on('close', () => {
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
