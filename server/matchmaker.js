/**
 * Matchmaker — public random-match queue, runtime-agnostic.
 *
 * The MatchmakingDO from docs/multiplayer-plan.md. Players who pick "public"
 * join a per-size queue; when `size` players are waiting a match forms. A
 * fill-timeout forms a partial match topped up with bots so a lone player is
 * never stuck forever. Private (room-code) games skip this entirely.
 *
 * It owns no transport and no rooms — the host injects `formMatch(size,
 * entries, withBots)` which mints the room, admits it, and seats the players.
 * That keeps this logic identical across the Node ws server, a Cloudflare DO,
 * and unit tests (which inject a synchronous scheduler).
 */

export class Matchmaker {
    /**
     * @param {object} opts
     * @param {(size:number, entries:object[], withBots:boolean)=>void} opts.formMatch
     * @param {number} [opts.fillMs]   wait before bot-filling a partial match
     * @param {(fn:Function, ms:number)=>any} [opts.schedule]
     * @param {(handle:any)=>void} [opts.cancelTimer]
     * @param {boolean} [opts.botFill]  fill empty seats with bots on timeout
     */
    constructor(opts) {
        this.formMatch = opts.formMatch;
        this.fillMs = opts.fillMs ?? 20_000;
        this.schedule = opts.schedule || ((fn, ms) => setTimeout(fn, ms));
        this.cancelTimer = opts.cancelTimer || ((h) => clearTimeout(h));
        this.botFill = opts.botFill !== false;
        this.queues = new Map();  // size -> entry[]
        this.byId = new Map();    // id -> entry
    }

    /**
     * @param {{id:string, size:number}} entry  carries whatever the host needs
     *        to seat the player later (ws/conn refs, name…)
     * @returns {{queued:boolean, waiting?:number}}
     */
    enqueue(entry) {
        const size = entry.size;
        if (this.byId.has(entry.id)) this.cancel(entry.id); // re-queue cleanly
        if (!this.queues.has(size)) this.queues.set(size, []);
        const q = this.queues.get(size);
        q.push(entry);
        this.byId.set(entry.id, entry);

        if (q.length >= size) {
            this._form(size, q.splice(0, size), false);
            return { queued: false };
        }
        if (this.botFill) {
            entry._timer = this.schedule(() => this._fillTimeout(entry), this.fillMs);
        }
        return { queued: true, waiting: q.length };
    }

    /** Remove a player from its queue (cancel / disconnect). */
    cancel(id) {
        const entry = this.byId.get(id);
        if (!entry) return false;
        this._removeFromQueue(entry);
        this.byId.delete(id);
        return true;
    }

    waiting(size) {
        return (this.queues.get(size) || []).length;
    }

    _fillTimeout(entry) {
        const q = this.queues.get(entry.size);
        if (!q || !q.includes(entry)) return; // already matched / cancelled
        const taking = q.splice(0, Math.min(entry.size, q.length));
        this._form(entry.size, taking, true);
    }

    _form(size, entries, withBots) {
        for (const e of entries) {
            if (e._timer != null) this.cancelTimer(e._timer);
            this.byId.delete(e.id);
        }
        this.formMatch(size, entries, withBots);
    }

    _removeFromQueue(entry) {
        const q = this.queues.get(entry.size);
        if (q) {
            const i = q.indexOf(entry);
            if (i >= 0) q.splice(i, 1);
        }
        if (entry._timer != null) this.cancelTimer(entry._timer);
    }
}
