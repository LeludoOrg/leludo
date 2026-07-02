/**
 * AdmissionDO — the hard-capacity gate as a Cloudflare Durable Object.
 *
 * A single global instance (idFromName("global")) is the ONLY place that
 * authorizes a new room, so the operator's caps protect every path. It wraps
 * the runtime-agnostic `Admission` class (server/admission.js) unchanged; this
 * shell just persists the counters to DO
 * storage so they survive the eviction/hibernation this DO undergoes between
 * calls (it holds no long-lived socket to pin it in memory).
 *
 * Endpoints (called by the rooms, never the client directly):
 *   GET /admit?room=CODE    → Admission.tryAdmit  → { ok, roomId } | { ok:false, reason }
 *   GET /release?room=CODE   → Admission.release   → { ok, freed }
 *   GET /stats               → Admission.stats
 *
 * Daily reset is lazy (Admission._rollDayIfNeeded runs on every admit/stats), so
 * no alarm is needed — the first request after UTC midnight rolls the counter.
 */
import { Admission, ADMISSION_DEFAULTS } from '../admission.js';
import { json, numEnv } from './cf-utils.js';

const KEY = 'admission';

export class AdmissionDO {
    constructor(state, env) {
        this.state = state;
        this.admission = new Admission({
            maxConcurrentGames: numEnv(env.MAX_CONCURRENT_GAMES, ADMISSION_DEFAULTS.maxConcurrentGames),
            maxGamesPerDay: numEnv(env.MAX_GAMES_PER_DAY, ADMISSION_DEFAULTS.maxGamesPerDay),
        });
        this._loaded = false;
    }

    /** Hydrate the in-memory Admission from storage once per instance lifetime.
     *  DO input-gating serialises fetches, so no lock is needed. */
    async _load() {
        if (this._loaded) return;
        const snap = await this.state.storage.get(KEY);
        if (snap) {
            this.admission.activeRooms = new Set(snap.activeRooms || []);
            this.admission.gamesStartedToday = snap.gamesStartedToday || 0;
            if (snap.dayStamp != null) this.admission._dayStamp = snap.dayStamp;
        }
        this._loaded = true;
    }

    async _save() {
        await this.state.storage.put(KEY, {
            activeRooms: [...this.admission.activeRooms],
            gamesStartedToday: this.admission.gamesStartedToday,
            dayStamp: this.admission._dayStamp,
        });
    }

    async fetch(request) {
        await this._load();
        const url = new URL(request.url);
        const room = url.searchParams.get('room');

        switch (url.pathname) {
            case '/admit': {
                const verdict = this.admission.tryAdmit(room);
                await this._save();
                return json(verdict);
            }
            case '/release': {
                const freed = this.admission.release(room);
                await this._save();
                return json({ ok: true, freed });
            }
            case '/stats':
            default:
                // stats() also rolls the day over; persist so the reset sticks.
                { const s = this.admission.stats(); await this._save(); return json(s); }
        }
    }
}
