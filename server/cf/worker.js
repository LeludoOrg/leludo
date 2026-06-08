/**
 * Cloudflare Worker — the multiplayer entry point / router.
 *
 * Production transport shell over the SAME runtime-agnostic modules the local
 * Node `ws` server uses (server/room-engine.js, server/admission.js,
 * server/matchmaker.js). The only thing that differs between local dev and prod
 * is this shell + the Durable Object wrappers in server/cf/* — all game rules
 * stay in scripts/* (see docs/multiplayer-plan.md → "Reuse of existing pure
 * modules").
 *
 * The Worker holds NO game state. It terminates `wss://`, then forwards the
 * upgrade to the Durable Object that owns the room:
 *   - private (room code)  → LudoRoomDO addressed by the code (idFromName)
 *   - public (matchmaking) → the MatchmakingDO singleton
 * Plain HTTP `/health` + `/stats` answer monitoring without touching a room.
 */
import { json } from './cf-utils.js';

export { LudoRoomDO } from './room-do.js';
export { AdmissionDO } from './admission-do.js';
export { MatchmakingDO } from './match-do.js';

const ADMISSION_NAME = 'global';
const MATCH_NAME = 'global';

export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        if (url.pathname === '/health') {
            return json({ ok: true });
        }
        if (url.pathname === '/stats') {
            // Surface the live admission counters (active rooms, games today, caps)
            // for monitoring — the same shape as local-server's /stats.
            const stub = env.ADMISSION.get(env.ADMISSION.idFromName(ADMISSION_NAME));
            return stub.fetch('https://do/stats');
        }

        if (request.headers.get('Upgrade') !== 'websocket') {
            return new Response('expected a websocket upgrade', { status: 426 });
        }

        // Public matchmaking routes to the queue singleton; everything else is a
        // private room keyed by its code (defaulting to "default" so the dev
        // harness works without a code).
        if (url.searchParams.get('mode') === 'public') {
            const stub = env.MATCH.get(env.MATCH.idFromName(MATCH_NAME));
            return stub.fetch(request);
        }

        const room = (url.searchParams.get('room') || 'default').toUpperCase();
        const stub = env.ROOM.get(env.ROOM.idFromName(room));
        return stub.fetch(request);
    },
};
