/**
 * LudoRoomDO wiring, exercised inside real workerd (via @cloudflare/vitest-pool-
 * workers) with the production wrangler.toml bindings. The pure engine has its
 * own happy-dom suite; THIS file guards the Cloudflare-specific seams that have
 * no equivalent in the Node dev server and so were previously untested:
 *   - WebSocket Hibernation accept (state.acceptWebSocket) + frame delivery
 *   - webSocketMessage → engine intent dispatch
 *   - persistence of engine state to DO storage on every broadcast
 *   - the {"t":"ping"} keepalive answered by setWebSocketAutoResponse
 *   - the zero-connection leak-guard alarm
 *
 * Rehydration-after-eviction is covered by the engine serialize/restore unit
 * tests — miniflare doesn't expose a way to force a hibernation eviction here.
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

/** Read the persisted engine snapshot straight out of the room DO's storage. */
async function readSnap(room) {
    let snap;
    await runInDurableObject(env.ROOM.getByName(room), async (_inst, state) => {
        snap = await state.storage.get('snapshot');
    });
    return snap;
}

async function waitSnap(room, pred, timeout = 3000) {
    const start = Date.now();
    let last;
    while (Date.now() - start < timeout) {
        last = await readSnap(room);
        if (last && pred(last)) return last;
        await sleep(20);
    }
    throw new Error(`snapshot condition unmet in ${timeout}ms; last=${JSON.stringify(last)}`);
}

describe('LudoRoomDO (workerd)', () => {
    it('accepts a socket, seats the host, and persists a snapshot', async () => {
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
        await waitFor(msgs, 'state'); // lobby broadcast

        // The DO must have written the engine to storage (hibernation depends on it).
        const snap = await waitSnap('ROOMA', (s) => !!s);
        expect(snap.roomId).toBe('ROOMA');
        expect(snap.phase).toBe('LOBBY');

        ws.close();
    });

    it('dispatches a roll over the socket and advances the persisted state', async () => {
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
        const started = await waitSnap('ROOMB', (s) => s.phase === 'AWAIT_ROLL' && s.started);
        const seqBefore = started.seq;
        const current = started.currentPlayerIndex;
        const roller = current === 0 ? host : guest;

        roller.send(JSON.stringify({ t: 'roll' }));
        // A processed roll broadcasts (and persists) at least once more.
        const after = await waitSnap('ROOMB', (s) => s.seq > seqBefore);
        expect(after.seq).toBeGreaterThan(seqBefore);
        expect(['AWAIT_ROLL', 'AWAIT_MOVE']).toContain(after.phase); // still mid-game

        host.close(); guest.close();
    });

    it('auto-answers the keepalive ping without invoking the engine', async () => {
        const res = await SELF.fetch(
            'https://leludo.test/?room=ROOMC&session=host&name=Host&size=2',
            { headers: { Upgrade: 'websocket' } },
        );
        const ws = res.webSocket; ws.accept();
        const msgs = collect(ws);
        await waitFor(msgs, 'seated');

        // The engine never replies to a ping — only setWebSocketAutoResponse does,
        // so receiving a pong proves the runtime answered it (and didn't wake the DO).
        ws.send(JSON.stringify({ t: 'ping' }));
        const pong = await waitFor(msgs, 'pong');
        expect(pong.t).toBe('pong');

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
        await waitFor(collect(host), 'seated');

        const guestRes = await SELF.fetch(
            'https://leludo.test/?room=ROOMD&session=guest&name=Guest&size=2',
            { headers: { Upgrade: 'websocket' } },
        );
        const guest = guestRes.webSocket; guest.accept();
        await waitFor(collect(guest), 'seated');

        host.send(JSON.stringify({ t: 'lobby_start' }));
        await waitSnap('ROOMD', (s) => s.started);

        host.close();
        guest.close();

        // After the last socket goes mid-game, _onGone sets a storage alarm.
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
