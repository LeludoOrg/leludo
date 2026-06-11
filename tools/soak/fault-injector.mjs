/**
 * Fault injection for the headless soak client.
 *
 * The desync the harness hunts is a CLIENT reconcile bug: a dropped / delayed /
 * reordered server frame, or a reconnect, leaves the client's board permanently
 * diverged from the server unless reconcile heals it. To reproduce that we wrap
 * the transport and interpose on the INBOUND message path — BEFORE net-client.js
 * hands a frame to online-game.handleOnlineMessage — so the real pipeline sees a
 * lossy/disordered stream exactly as a flaky network would deliver it.
 *
 * `makeFaultyWebSocket(WsImpl, control)` returns a class with the browser
 * WebSocket shape (addEventListener/send/close/readyState/OPEN), backed by a real
 * `ws` socket. The `ws` package already implements addEventListener + MessageEvent
 * `.data`, so net-client.js drives it unmodified. NetClient also reconnects with a
 * fresh `new WebSocket(...)` on an unexpected close (lib net-client.js), so each
 * connection gets a fresh wrapper reading the same shared `control`.
 *
 * Faults are OUTBOUND-safe: client → server intents (roll/move) always pass
 * through untouched; only server → client delivery is perturbed. That mirrors the
 * real failure mode (the server stays authoritative; the client misses frames).
 */

/**
 * @param {object} WsImpl  the `ws` package's WebSocket class
 * @param {object} control
 * @param {{dropProb?:number, delayMs?:number, reorderProb?:number,
 *          throttle?:{batchMs:number}|null}} control.config
 * @param {() => number} control.rng           seeded PRNG in [0,1)
 * @param {(info:object) => void} [control.onFault]  telemetry hook
 * @param {object|null} control.current         set to the latest live wrapper
 */
export function makeFaultyWebSocket(WsImpl, control) {
    const cfg = control.config || {};
    const rng = control.rng || Math.random;
    const note = (kind, extra) => { try { control.onFault?.({ kind, ...extra }); } catch { /* ignore */ } };

    return class FaultyWebSocket {
        static CONNECTING = 0;
        static OPEN = 1;
        static CLOSING = 2;
        static CLOSED = 3;

        constructor(url, protocols) {
            this._ws = new WsImpl(url, protocols);
            this._listeners = { open: new Set(), message: new Set(), close: new Set(), error: new Set() };
            this._closedByFault = false;
            // Pending inbound frames held by delay/throttle, flushed in order.
            this._holdQueue = [];
            this._throttleTimer = null;

            control.current = this;

            this._ws.addEventListener('open', (ev) => this._emit('open', ev));
            this._ws.addEventListener('error', (ev) => this._emit('error', ev));
            this._ws.addEventListener('close', (ev) => {
                this._clearThrottle();
                this._emit('close', ev);
            });
            this._ws.addEventListener('message', (ev) => this._onInbound(ev));
        }

        // ----- browser WebSocket surface used by net-client.js -----
        get readyState() { return this._ws.readyState; }
        get url() { return this._ws.url; }

        addEventListener(type, listener) { this._listeners[type]?.add(listener); }
        removeEventListener(type, listener) { this._listeners[type]?.delete(listener); }

        send(data) { this._ws.send(data); }              // intents pass through untouched
        close(code, reason) { this._clearThrottle(); this._ws.close(code, reason); }

        // ----- fault control (called by the worker harness) -----
        /** Kill the underlying socket WITHOUT NetClient's _closedByUs flag, so
         *  NetClient auto-reconnects (rejoins the room → server replays a
         *  reason:'reconnect' catch-up snapshot). This is the reconnect fault. */
        forceDrop(code = 4000) {
            this._closedByFault = true;
            this._clearThrottle();
            note('reconnect', {});
            try { this._ws.close(code, 'soak-fault'); } catch { /* ignore */ }
        }

        // ----- inbound fault pipeline -----
        _onInbound(ev) {
            const cls = classify(ev.data);

            // Drop models a "1s socket blip dropping `moved` frames" / a swallowed
            // animation — a missed IN-GAME DELTA the reconcile is meant to heal. We
            // only drop `moved` frames: over a real WebSocket (TCP) the transport
            // never loses bytes, and dropping SEATED / the start / a turn-sync /
            // the reconnect catch-up would model a failure that can't happen and
            // would break the client unfairly. The next frame's reconcile carries
            // the authoritative board, so a healthy client recovers.
            if (cfg.dropProb > 0 && cls.droppable && rng() < cfg.dropProb) {
                note('drop', { data: peek(ev.data) });
                return;
            }

            const timingActive = !!cfg.throttle || cfg.delayMs > 0;

            // FIFO is sacrosanct: TCP delivers in order, so once ANY frame is held
            // (delay/throttle) EVERY later frame — control frames included — queues
            // behind it. Otherwise an un-held ENDED could overtake a delayed `moved`
            // and forge a desync that can't happen on the wire.
            if (!timingActive && this._holdQueue.length === 0) {
                // Reorder is the ONLY fault that deliberately breaks order, and only
                // between two in-game frames.
                if (cfg.reorderProb > 0 && cls.inGame && rng() < cfg.reorderProb) {
                    this._holdQueue.push(ev);
                    setTimeout(() => this._flushOne(), 0);
                    return;
                }
                this._deliver(ev);
                return;
            }

            this._holdQueue.push(ev);
            if (cfg.reorderProb > 0 && cls.inGame && this._holdQueue.length > 1 && rng() < cfg.reorderProb) {
                note('reorder', {});
                const n = this._holdQueue.length;
                [this._holdQueue[n - 1], this._holdQueue[n - 2]] = [this._holdQueue[n - 2], this._holdQueue[n - 1]];
            }

            if (cfg.throttle) {
                this._scheduleThrottleFlush();
            } else {
                setTimeout(() => this._flushOne(), cfg.delayMs);
            }
        }

        _scheduleThrottleFlush() {
            if (this._throttleTimer) return;
            const batchMs = cfg.throttle.batchMs || 250;
            note('throttle', { batchMs });
            this._throttleTimer = setTimeout(() => {
                this._throttleTimer = null;
                const batch = this._holdQueue.splice(0, this._holdQueue.length);
                for (const ev of batch) this._deliver(ev);
            }, batchMs);
        }

        _flushOne() {
            const ev = this._holdQueue.shift();
            if (ev) this._deliver(ev);
        }

        _clearThrottle() {
            if (this._throttleTimer) { clearTimeout(this._throttleTimer); this._throttleTimer = null; }
            this._holdQueue.length = 0;
        }

        _deliver(ev) {
            // net-client.js reads ev.data and JSON.parses it; re-wrap to that shape.
            this._dispatch('message', { data: ev.data });
        }

        _emit(type, ev) { this._dispatch(type, ev); }

        _dispatch(type, ev) {
            for (const l of this._listeners[type]) {
                try { l(ev); } catch (e) { /* a listener throwing must not wedge others */ }
            }
        }
    };
}

/** First ~80 chars of a frame for fault telemetry (full frame is large). */
function peek(data) {
    try { return String(data).slice(0, 80); } catch { return ''; }
}

// Server→client reasons safe to PERTURB-by-timing (in-game updates). The drop
// fault is narrower still (moved-only) — see _onInbound.
const INGAME_REASONS = new Set(['rolled', 'no-move', 'three-sixes', 'again', 'turn', 'moved']);

/**
 * Classify an inbound frame so faults skip handshake/lifecycle/catch-up frames
 * a real transport never loses (SEATED, the start broadcast, turn-sync after a
 * reconnect, ENDED). Returns { inGame, droppable }.
 */
function classify(data) {
    let msg;
    try { msg = JSON.parse(data); } catch { return { inGame: false, droppable: false }; }
    if (msg.t === 'moved') return { inGame: true, droppable: true };
    if (msg.t === 'state') {
        // Never perturb the lobby/start handshake or the reconnect catch-up.
        const r = msg.reason;
        const started = msg.state?.started === true;
        const inGame = started && INGAME_REASONS.has(r) && r !== 'reconnect';
        return { inGame, droppable: false }; // STATE carries turn-sync — never DROP it
    }
    return { inGame: false, droppable: false };
}
