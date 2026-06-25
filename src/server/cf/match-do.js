/**
 * MatchmakingDO — public random-match queue singleton.
 *
 * NOT on the launch path. The shipped client is private-rooms-only
 * (components/wc-quick-start.js), so no client sends `mode=public` yet; this DO
 * is wired for parity with docs/multiplayer-plan.md and to keep the queue logic
 * (server/matchmaker.js) deployed and testable.
 *
 * Cross-DO caveat — why this needs one more client change before it's live:
 *   A WebSocket belongs to exactly ONE Durable Object. A socket queued *here*
 *   cannot be transferred into a LudoRoomDO. So when a match forms we mint +
 *   admit a room and send each player `{ t:"matched", room }`, then close their
 *   queue socket — the client is expected to redial `/?room=CODE` (the private
 *   path) to actually enter the game. The local Node server cheats this by
 *   re-binding the same socket in-process; on CF the client must redial. Wiring
 *   that redial (net-client: on `matched`, reopen against the room) is the
 *   remaining task to turn public matchmaking on.
 */
import { Matchmaker } from '../matchmaker.js';
import { mintRoomCode } from '../../scripts/core/room-code.js';
import { clampSeats, numEnv, safeSend, safeParse, safeClose, ADMISSION_NAME, requireWebsocket } from './cf-utils.js';
import { MSG } from '../../scripts/net/net-protocol.js';

export class MatchmakingDO {
    constructor(state, env) {
        this.state = state;
        this.env = env;
        this.bySocket = new Map();   // WebSocket -> { id }
        this.matchmaker = new Matchmaker({
            fillMs: numEnv(env.MATCH_FILL_MS, 20_000),
            formMatch: (size, entries, withBots) => this._formMatch(size, entries, withBots),
        });
    }

    _admissionStub() {
        return this.env.ADMISSION.get(this.env.ADMISSION.idFromName(ADMISSION_NAME));
    }

    async fetch(request) {
        const notWs = requireWebsocket(request);
        if (notWs) return notWs;
        const q = new URL(request.url).searchParams;
        const sessionId = q.get('session') || `anon-${crypto.randomUUID()}`;
        const name = q.get('name') || '';
        const size = Math.max(2, clampSeats(q.get('size'), 2));

        const pair = new WebSocketPair();
        const client = pair[0];
        const server = pair[1];
        server.accept();
        this.bySocket.set(server, { id: sessionId });

        const res = this.matchmaker.enqueue({ id: sessionId, size, name, ws: server });
        if (res.queued) safeSend(server, JSON.stringify({ t: MSG.QUEUED, size, waiting: res.waiting }));

        server.addEventListener('message', (ev) => {
            const msg = safeParse(ev.data);
            if (!msg) return;
            if (msg.t === MSG.QUEUE_CANCEL) {
                this.matchmaker.cancel(sessionId);
                safeSend(server, JSON.stringify({ t: MSG.QUEUE_LEFT }));
            }
        });
        const leave = () => { this.matchmaker.cancel(sessionId); this.bySocket.delete(server); };
        server.addEventListener('close', leave);
        server.addEventListener('error', leave);

        return new Response(null, { status: 101, webSocket: client });
    }

    /** A match formed: mint+admit a room, then point each player at it (redial). */
    _formMatch(size, entries, _withBots) {
        const code = mintRoomCode(() => false); // collisions resolve at the room DO
        // Admission is async; the Matchmaker callback is sync, so fire-and-forget.
        (async () => {
            const res = await this._admissionStub().fetch(`https://do/admit?room=${code}`);
            const verdict = await res.json();
            for (const e of entries) {
                if (!verdict.ok) { safeSend(e.ws, JSON.stringify({ t: MSG.BUSY, reason: verdict.reason })); continue; }
                safeSend(e.ws, JSON.stringify({ t: MSG.MATCHED, room: code }));
                safeClose(e.ws, 1000, 'matched');
            }
        })();
    }
}
