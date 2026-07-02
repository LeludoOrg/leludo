/**
 * AdmissionDO logic — the hard-capacity gate, runtime-agnostic.
 *
 * This is the *only* place that authorizes a new game room. It is pure JS with
 * an injectable clock so it runs identically inside:
 *   - a Cloudflare Durable Object (production AND dev/e2e under `wrangler dev`),
 *   - vitest (unit tests, with `now` advanced by hand).
 *
 * See docs/multiplayer-plan.md → "AdmissionDO". Caps are sized to stay inside
 * the Cloudflare Workers Paid ($5/mo) plan's INCLUDED Durable-Object allowance
 * (no overage); hitting one returns a friendly BUSY reason rather than spending
 * into a throttle / paid overage. The caps remain the real footgun guard on the
 * paid plan (a Cloudflare billing alert is the backstop) — see multiplayer-plan.
 */

import { BUSY } from '../scripts/net/net-protocol.js';

export const ADMISSION_DEFAULTS = Object.freeze({
    maxConcurrentGames: 250,  // simultaneous rooms (soft-realtime guard)
    maxGamesPerDay: 1000,     // new games / UTC day (this default is prod-shaped) — ~1,668 SQL rows/4p game (live prod data); prod 1000/day ≈ 1.67M rows ≈ 50M rows-written/month, right at the paid plan's INCLUDED 50M/month allowance (account-wide; beta's small 25/day slice on top tips a touch over → minor metered overage, ~$1-2/mo, caught by the billing alert)
});

const MS_PER_DAY = 86_400_000;

export class Admission {
    /**
     * @param {{maxConcurrentGames?:number, maxGamesPerDay?:number}} [config]
     * @param {() => number} [now]  injectable clock (ms since epoch); defaults to Date.now
     */
    constructor(config = {}, now = () => Date.now()) {
        this.maxConcurrent = config.maxConcurrentGames ?? ADMISSION_DEFAULTS.maxConcurrentGames;
        this.maxPerDay = config.maxGamesPerDay ?? ADMISSION_DEFAULTS.maxGamesPerDay;
        this._now = now;
        this.activeRooms = new Set();       // currently-running room ids
        this.gamesStartedToday = 0;         // resets at UTC midnight
        this._dayStamp = this._utcDay(now());
    }

    _utcDay(ms) {
        return Math.floor(ms / MS_PER_DAY);
    }

    /** Roll the daily counter over if the UTC day changed (the DO-alarm equivalent). */
    _rollDayIfNeeded() {
        const day = this._utcDay(this._now());
        if (day !== this._dayStamp) {
            this._dayStamp = day;
            this.gamesStartedToday = 0;
        }
    }

    /**
     * Authorize a room. Joining an already-active room is always allowed and does
     * NOT consume a new daily slot (a public match / 2nd player joins one game).
     *
     * @param {string} roomId
     * @returns {{ok:true, roomId:string, already?:boolean} | {ok:false, reason:'BUSY_CONCURRENT'|'BUSY_DAILY'}}
     */
    tryAdmit(roomId) {
        this._rollDayIfNeeded();
        if (this.activeRooms.has(roomId)) {
            return { ok: true, roomId, already: true };
        }
        if (this.activeRooms.size >= this.maxConcurrent) {
            return { ok: false, reason: BUSY.CONCURRENT };
        }
        if (this.gamesStartedToday >= this.maxPerDay) {
            return { ok: false, reason: BUSY.DAILY };
        }
        this.activeRooms.add(roomId);
        this.gamesStartedToday++;
        return { ok: true, roomId };
    }

    /**
     * Release a finished/empty room. Idempotent — a room releases at most once,
     * so a double-release can't drive activeRooms negative.
     * @param {string} roomId
     * @returns {boolean}  true if this call actually freed a slot
     */
    release(roomId) {
        return this.activeRooms.delete(roomId);
    }

    /** @returns {{active:number, today:number, maxConcurrent:number, maxPerDay:number}} */
    stats() {
        this._rollDayIfNeeded();
        return {
            active: this.activeRooms.size,
            today: this.gamesStartedToday,
            maxConcurrent: this.maxConcurrent,
            maxPerDay: this.maxPerDay,
        };
    }
}
