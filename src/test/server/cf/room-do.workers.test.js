/**
 * LudoRoomDO wiring, exercised inside real workerd (via @cloudflare/vitest-pool-
 * workers) with the production wrangler.toml bindings. The pure engine has its
 * own happy-dom suite; THIS file guards the Cloudflare-specific seams that have
 * no equivalent in the Node dev server and so were previously untested:
 *   - resident `server.accept()` + frame delivery
 *   - message → engine intent dispatch (roll advances the broadcast state)
 *   - the join-by-code ROOM_NOT_FOUND reject vs the create→join happy path
 *   - the {"t":"ping"} keepalive being a harmless no-op (no reply, socket alive)
 *   - the zero-connection leak-guard alarm
 *
 * The DO is RESIDENT, not hibernated (see room-do.js header): there is no
 * per-broadcast snapshot write and no setWebSocketAutoResponse pong, so these
 * tests assert on the frames clients actually receive rather than on DO storage.
 */
import { env, SELF, runInDurableObject, runDurableObjectAlarm } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Collect every parsed frame a socket receives into a growing array. */
function collect(ws) {
    const msgs = [];
    ws.addEventListener('message', (e) => {
        try { msgs.push(JSON.parse(e.data)); } catch { /* ignore non-JSON */ }
    });
    return msgs;
}

/** Poll a frame buffer until one matches `pred` (default: type === arg). */
async function waitFor(msgs, pred, timeout = 3000) {
    const match = typeof pred === 'string' ? (m) => m.t === pred : pred;
    const start = Date.now();
    while (Date.now() - start < timeout) {
        const hit = msgs.find(match);
        if (hit) return hit;
        await sleep(15);
    }
    throw new Error(`no matching frame in ${timeout}ms; saw [${msgs.map((m) => m.t).join(', ')}]`);
}

describe('LudoRoomDO (workerd)', () => {
    it('accepts a socket and seats the host', async () => {
        const res = await SELF.fetch(
            'https://leludo.test/?room=ROOMA&session=host&name=Host&size=2',
            { headers: { Upgrade: 'websocket' } },
        );
        expect(res.status).toBe(101);
        const ws = res.webSocket;
        ws.accept();
        const msgs = collect(ws);

        const seated = await waitFor(msgs, 'seated');
        expect(seated.playerIndex).toBe(0);
        expect(seated.isHost).toBe(true);
        const lobby = await waitFor(msgs, 'state'); // lobby broadcast
        expect(lobby.state.phase).toBe('LOBBY');

        ws.close();
    });

    it('dispatches a roll over the socket and advances the broadcast state', async () => {
        const hostRes = await SELF.fetch(
            'https://leludo.test/?room=ROOMB&session=host&name=Host&size=2',
            { headers: { Upgrade: 'websocket' } },
        );
        const host = hostRes.webSocket; host.accept();
        const hostMsgs = collect(host);
        await waitFor(hostMsgs, 'seated');

        const guestRes = await SELF.fetch(
            'https://leludo.test/?room=ROOMB&session=guest&name=Guest&size=2',
            { headers: { Upgrade: 'websocket' } },
        );
        const guest = guestRes.webSocket; guest.accept();
        const guestMsgs = collect(guest);
        await waitFor(guestMsgs, 'seated');

        host.send(JSON.stringify({ t: 'lobby_start' }));
        // Both clients see the game start (AWAIT_ROLL); the highest seq so far is
        // our "before" mark — a processed roll must broadcast a higher one.
        const started = await waitFor(hostMsgs, (m) => m.t === 'state' && m.state.phase === 'AWAIT_ROLL' && m.state.started);
        const seqBefore = started.seq;
        const roller = started.state.currentPlayerIndex === 0 ? host : guest;
        const rollerMsgs = started.state.currentPlayerIndex === 0 ? hostMsgs : guestMsgs;

        roller.send(JSON.stringify({ t: 'roll' }));
        // A processed roll broadcasts a fresh state frame with a higher seq and a
        // resolved die, still mid-game (rolled → AWAIT_MOVE, or no-move/again).
        const after = await waitFor(rollerMsgs, (m) => m.t === 'state' && m.seq > seqBefore);
        expect(after.seq).toBeGreaterThan(seqBefore);
        expect(['AWAIT_ROLL', 'AWAIT_MOVE']).toContain(after.state.phase); // still mid-game

        host.close(); guest.close();
    });

    it('rejects a join-by-code into a room nobody created (ROOM_NOT_FOUND)', async () => {
        // A `join=1` connect to a fresh code must NOT silently spin up a ghost
        // room — the server closes the socket with ROOM_NOT_FOUND instead.
        const res = await SELF.fetch(
            'https://leludo.test/?room=GHOST&session=stranger&name=Lost&join=1',
            { headers: { Upgrade: 'websocket' } },
        );
        expect(res.status).toBe(101);
        const ws = res.webSocket; ws.accept();
        const msgs = collect(ws);

        const err = await waitFor(msgs, 'error');
        expect(err.error).toBe('ROOM_NOT_FOUND');
        // Never seated.
        expect(msgs.find((m) => m.t === 'seated')).toBeUndefined();
    });

    it('lets the host create a room, then a guest join it by code', async () => {
        // The mirror of the reject: `create=1` mints the room, and a later
        // `join=1` to the SAME code is admitted (the engine now exists).
        const hostRes = await SELF.fetch(
            'https://leludo.test/?room=MADE&session=host&name=Host&size=2&create=1',
            { headers: { Upgrade: 'websocket' } },
        );
        const host = hostRes.webSocket; host.accept();
        await waitFor(collect(host), 'seated');

        const guestRes = await SELF.fetch(
            'https://leludo.test/?room=MADE&session=guest&name=Guest&join=1',
            { headers: { Upgrade: 'websocket' } },
        );
        const guest = guestRes.webSocket; guest.accept();
        const guestMsgs = collect(guest);
        const seated = await waitFor(guestMsgs, 'seated');
        expect(seated.playerIndex).toBeGreaterThan(0); // joined an existing room, not host
        expect(guestMsgs.find((m) => m.t === 'error')).toBeUndefined();

        host.close(); guest.close();
    });

    it('treats the keepalive ping as a harmless no-op (no reply, socket stays live)', async () => {
        const res = await SELF.fetch(
            'https://leludo.test/?room=ROOMC&session=host&name=Host&size=2',
            { headers: { Upgrade: 'websocket' } },
        );
        const ws = res.webSocket; ws.accept();
        const msgs = collect(ws);
        await waitFor(msgs, 'seated');
        const seenBefore = msgs.length;

        // The engine ignores a ping (the inbound frame just keeps the socket warm
        // at the DO). It must NOT reply and must NOT error or close the socket.
        ws.send(JSON.stringify({ t: 'ping' }));
        await sleep(120);
        expect(msgs.length).toBe(seenBefore);
        expect(msgs.find((m) => m.t === 'pong' || m.t === 'error')).toBeUndefined();

        // The socket is still usable afterwards — a real intent still broadcasts
        // a fresh state frame past everything seen before the ping.
        const seqBefore = msgs[msgs.length - 1]?.seq ?? 0;
        ws.send(JSON.stringify({ t: 'lobby_size', size: 3 }));
        const fresh = await waitFor(msgs, (m) => m.t === 'state' && m.seq > seqBefore);
        expect(fresh.seq).toBeGreaterThan(seqBefore);

        ws.close();
    });

    it('arms the leak-guard alarm when every socket drops mid-game', async () => {
        // The engine now HOLDS a dropped seat for the reconnect window in the
        // lobby too (a brief blip mustn't reassign the host), so an emptied room
        // no longer ends synchronously. Whether the last socket drops in the
        // lobby or mid-game, only the zero-connection alarm can reclaim the
        // admission slot if nobody comes back.
        const hostRes = await SELF.fetch(
            'https://leludo.test/?room=ROOMD&session=host&name=Host&size=2',
            { headers: { Upgrade: 'websocket' } },
        );
        const host = hostRes.webSocket; host.accept();
        const hostMsgs = collect(host);
        await waitFor(hostMsgs, 'seated');

        const guestRes = await SELF.fetch(
            'https://leludo.test/?room=ROOMD&session=guest&name=Guest&size=2',
            { headers: { Upgrade: 'websocket' } },
        );
        const guest = guestRes.webSocket; guest.accept();
        await waitFor(collect(guest), 'seated');

        host.send(JSON.stringify({ t: 'lobby_start' }));
        await waitFor(hostMsgs, (m) => m.t === 'state' && m.state.started);

        host.close();
        guest.close();

        // After the last socket goes mid-game, _onClose sets a storage alarm.
        let alarmAt = null;
        const start = Date.now();
        while (Date.now() - start < 3000 && !alarmAt) {
            await runInDurableObject(env.ROOM.getByName('ROOMD'), async (_i, state) => {
                alarmAt = await state.storage.getAlarm();
            });
            if (!alarmAt) await sleep(20);
        }
        expect(alarmAt).toBeGreaterThan(0);

        // Firing it releases the slot cleanly (no throw) on the still-empty room.
        const ran = await runDurableObjectAlarm(env.ROOM.getByName('ROOMD'));
        expect(ran).toBe(true);
    });
});
