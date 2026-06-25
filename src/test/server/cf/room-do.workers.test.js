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

    it('drops the engine on release so a re-join reads GONE (ROOM_NOT_FOUND), not FULL', async () => {
        // Regression: a private room that releases its admission slot (the game
        // ended / was abandoned) must read as ROOM_NOT_FOUND when the same code is
        // dialled again — NOT ROOM_FULL. The resident DO used to keep its old
        // engine after release, so a fresh join hit the no-open-seat path
        // (ROOM_FULL, since the dead lobby's seats were all still claimed) instead
        // of the no-engine path. _release now nulls the engine. We force the
        // release directly on the SAME resident instance (a socket stays open so
        // it isn't evicted), which is exactly the in-memory state production hits
        // when _end → transport.release fires while a client is still attached.
        const room = 'GONEROOM';
        const hostRes = await SELF.fetch(
            `https://leludo.test/?room=${room}&session=host&name=Host&size=2&create=1`,
            { headers: { Upgrade: 'websocket' } },
        );
        const host = hostRes.webSocket; host.accept();
        const hostMsgs = collect(host);
        await waitFor(hostMsgs, 'seated');

        const guestRes = await SELF.fetch(
            `https://leludo.test/?room=${room}&session=guest&name=Guest&join=1`,
            { headers: { Upgrade: 'websocket' } },
        );
        const guest = guestRes.webSocket; guest.accept();
        await waitFor(collect(guest), 'seated');
        guest.close();

        // Release the slot on the live, resident instance — then assert the engine
        // is gone (the fix) rather than lingering with a full lobby (the bug).
        await runInDurableObject(env.ROOM.getByName(room), async (instance) => {
            expect(instance.engine).not.toBeNull(); // sanity: it WAS resident
            await instance._release();
            expect(instance.engine).toBeNull();     // the fix: torn down on release
        });

        // Re-enter the same code on that same resident instance: no engine now →
        // ROOM_NOT_FOUND (gone), never ROOM_FULL (what a lingering engine produced).
        const againRes = await SELF.fetch(
            `https://leludo.test/?room=${room}&session=newcomer&name=New&join=1`,
            { headers: { Upgrade: 'websocket' } },
        );
        const again = againRes.webSocket; again.accept();
        const againMsgs = collect(again);
        const err = await waitFor(againMsgs, 'error');
        expect(err.error).toBe('ROOM_NOT_FOUND');
        expect(againMsgs.find((m) => m.t === 'seated')).toBeUndefined();

        host.close();
        again.close();
    });

    it('restores an evicted mid-game room from storage so a reconnect resumes it', async () => {
        // Regression: a code deploy (or DO migration) SHUTS DOWN the running DO —
        // wiping the in-memory engine and terminating every socket — then clients
        // reconnect into a COLD instance. Before persist/restore that cold instance
        // had no engine, so the joiner's `join=1` reconnect hit ROOM_NOT_FOUND (the
        // game "abruptly ended") and the host's `create=1` reconnect minted a FRESH
        // lobby (started:false → the client froze on a dead board). The persist hook
        // now snapshots every broadcast and _restore rebuilds the live game, so both
        // reconnects resume the SAME match. This guards the exact incident a beta
        // Worker deploy caused mid-game.
        const room = 'RESUME';
        const hostRes = await SELF.fetch(
            `https://leludo.test/?room=${room}&session=host&name=Host&size=2&create=1`,
            { headers: { Upgrade: 'websocket' } },
        );
        const host = hostRes.webSocket; host.accept();
        const hostMsgs = collect(host);
        await waitFor(hostMsgs, 'seated');

        const guestRes = await SELF.fetch(
            `https://leludo.test/?room=${room}&session=guest&name=Guest&join=1`,
            { headers: { Upgrade: 'websocket' } },
        );
        const guest = guestRes.webSocket; guest.accept();
        await waitFor(collect(guest), 'seated');

        host.send(JSON.stringify({ t: 'lobby_start' }));
        const started = await waitFor(hostMsgs, (m) => m.t === 'state' && m.state.started);
        const turnBefore = started.state.turn;

        // Simulate the deploy: drop the sockets, then wipe the in-memory instance
        // state the runtime would lose on eviction (engine + admission flags) while
        // Durable Object STORAGE survives — exactly what a code update does.
        host.close(); guest.close();
        await runInDurableObject(env.ROOM.getByName(room), async (instance) => {
            expect(await instance.state.storage.get('game')).toBeTruthy(); // snapshot persisted
            instance.engine = null;
            instance.admitted = false;
            instance.released = false;
            instance.roomId = null;
        });

        // Host reconnects FIRST with create=1: the cold instance must REBUILD the
        // started game from storage, not mint a fresh started:false lobby.
        const hostBackRes = await SELF.fetch(
            `https://leludo.test/?room=${room}&session=host&name=Host&size=2&create=1`,
            { headers: { Upgrade: 'websocket' } },
        );
        const hostBack = hostBackRes.webSocket; hostBack.accept();
        const hostBackMsgs = collect(hostBack);
        await waitFor(hostBackMsgs, 'seated');
        const hostResumed = await waitFor(hostBackMsgs, (m) => m.t === 'state' && m.state.started);
        expect(hostResumed.state.started).toBe(true);       // resumed, not a ghost lobby
        expect(hostResumed.state.turn).toBe(turnBefore);
        expect(hostBackMsgs.find((m) => m.t === 'error')).toBeUndefined();

        // Guest reconnects with join=1 — the path that returned ROOM_NOT_FOUND
        // before. It must seat back into its OWN seat on the resumed game.
        const guestBackRes = await SELF.fetch(
            `https://leludo.test/?room=${room}&session=guest&name=Guest&join=1`,
            { headers: { Upgrade: 'websocket' } },
        );
        const guestBack = guestBackRes.webSocket; guestBack.accept();
        const guestBackMsgs = collect(guestBack);
        const reseated = await waitFor(guestBackMsgs, 'seated');
        expect(reseated.playerIndex).toBeGreaterThan(0);     // same guest seat, not host
        expect(guestBackMsgs.find((m) => m.t === 'error')).toBeUndefined(); // never ROOM_NOT_FOUND

        hostBack.close(); guestBack.close();
    });

    // The dev/e2e test hooks (?seed / ?grace / __busy__) are gated behind the
    // DEV_TEST_HOOKS env var, which only `wrangler dev --var` sets for dev +
    // Playwright. This suite runs against the PRODUCTION wrangler.toml bindings,
    // where DEV_TEST_HOOKS is unset — so these assertions lock the guarantee that
    // a deployed Worker ignores the hooks entirely (the on-path is exercised
    // end-to-end by the grace/seed/busy e2e specs against wrangler dev). If a
    // refactor ever made a hook fire unconditionally, prod would leak it and one
    // of these fails loudly.
    it('ignores __busy__ in prod bindings (DEV_TEST_HOOKS unset) — seats normally', async () => {
        const res = await SELF.fetch(
            'https://leludo.test/?room=__busy__&session=host&name=Host&size=2',
            { headers: { Upgrade: 'websocket' } },
        );
        expect(res.status).toBe(101);
        const ws = res.webSocket; ws.accept();
        const msgs = collect(ws);
        // No DEV_TEST_HOOKS → the magic room is just a normal code: the host seats
        // instead of getting the deterministic BUSY reject.
        const seated = await waitFor(msgs, 'seated');
        expect(seated.isHost).toBe(true);
        expect(msgs.find((m) => m.t === 'busy')).toBeUndefined();
        ws.close();
    });

    it('ignores ?grace in prod bindings — keeps the env RECONNECT_GRACE_MS default', async () => {
        const res = await SELF.fetch(
            'https://leludo.test/?room=GRACEOFF&session=host&name=Host&size=2&grace=1234',
            { headers: { Upgrade: 'websocket' } },
        );
        const ws = res.webSocket; ws.accept();
        await waitFor(collect(ws), 'seated');
        // ?grace=1234 must NOT override the window without the hook flag: the engine
        // keeps the wrangler.toml [vars] RECONNECT_GRACE_MS (60000), not 1234.
        await runInDurableObject(env.ROOM.getByName('GRACEOFF'), async (instance) => {
            expect(instance.engine.graceMs).toBe(60000);
        });
        ws.close();
    });

    it('ignores ?seed in prod bindings — each room gets its own random dice stream', async () => {
        // Two rooms both asking for ?seed=7: with the hook OFF each falls back to a
        // fresh randomSeed(), so their RNG states differ. (Under DEV_TEST_HOOKS they
        // would be byte-identical — that determinism is what the e2e suite relies on.)
        const open = async (room) => {
            const res = await SELF.fetch(
                `https://leludo.test/?room=${room}&session=host&name=Host&size=2&seed=7`,
                { headers: { Upgrade: 'websocket' } },
            );
            const ws = res.webSocket; ws.accept();
            await waitFor(collect(ws), 'seated');
            let rng;
            await runInDurableObject(env.ROOM.getByName(room), async (instance) => {
                rng = JSON.stringify(instance.engine.serialize().rng);
            });
            ws.close();
            return rng;
        };
        const [a, b] = [await open('SEEDOFFA'), await open('SEEDOFFB')];
        expect(a).not.toBe(b);
    });

    it('does not resurrect a released room (snapshot dropped on release)', async () => {
        // The flip side of restore: once a room is released (ended / abandoned),
        // _release deletes the snapshot, so a later cold instance must read GONE
        // (ROOM_NOT_FOUND) rather than rebuild the dead game from a stale snapshot.
        const room = 'RELEASED';
        const hostRes = await SELF.fetch(
            `https://leludo.test/?room=${room}&session=host&name=Host&size=2&create=1`,
            { headers: { Upgrade: 'websocket' } },
        );
        const host = hostRes.webSocket; host.accept();
        await waitFor(collect(host), 'seated');

        await runInDurableObject(env.ROOM.getByName(room), async (instance, state) => {
            await instance._release();
            expect(await state.storage.get('game')).toBeFalsy(); // snapshot dropped
            instance.engine = null; // cold instance for the next dial
        });

        const backRes = await SELF.fetch(
            `https://leludo.test/?room=${room}&session=host&name=Host&join=1`,
            { headers: { Upgrade: 'websocket' } },
        );
        const back = backRes.webSocket; back.accept();
        const backMsgs = collect(back);
        const err = await waitFor(backMsgs, 'error');
        expect(err.error).toBe('ROOM_NOT_FOUND');

        host.close(); back.close();
    });
});
