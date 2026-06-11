/**
 * SoakClient — boots ONE real browser client headlessly and reports what it
 * believes the game state is, so the harness can compare it against the server.
 *
 * Fidelity is the whole point: the desync lives in the client reconcile path
 * (online-game.handleOnlineMessage → command-handler → game-reducer →
 * render-logic.setTurnCount/positions). So we run THOSE EXACT modules — not a
 * reimplementation — inside a happy-dom realm with:
 *   - a DOM fixture (dom-fixture.mjs) so the render writes don't throw,
 *   - sound muted (audio.js no-ops, no AudioContext needed),
 *   - location=localhost (analytics self-disables),
 *   - document.hidden=true so render-logic's animation paths fast-forward and
 *     resolve immediately (no rAF/transitionend hang) — which is ALSO the exact
 *     backgrounded-tab code path the reported desync occurs on, so running hidden
 *     is both fast AND high-signal.
 *   - the global WebSocket replaced by the fault-injecting wrapper.
 *
 * Module singletons (state, _seat, turnCount) mean ONE realm == ONE client, so
 * this is instantiated once per worker thread.
 *
 * Sampling: every inbound server frame is logged compactly (the per-step server
 * record) and fed to the real pipeline. The client's BELIEF is sampled at
 * "settle" — settleMs after the last frame AND the last store event — i.e. once
 * the online driver's promise chain has drained. A settled belief that differs
 * from the latest server snapshot is a permanent desync (the bug); transient
 * mid-replay lag is intentionally not flagged (see comparator strictness).
 */
import { Window } from 'happy-dom';
import { WebSocket as WsImpl } from 'ws';
import { installDomFixture } from './dom-fixture.mjs';
import { makeFaultyWebSocket } from '../../fault-injector.mjs';
import { DesyncTracker } from '../../comparator.mjs';

const SRC = new URL('../../../../src/', import.meta.url);
const srcUrl = (rel) => new URL(rel, SRC).href;

export class SoakClient {
    /**
     * @param {object} opts
     * @param {string} opts.url       resolved ws server base
     * @param {string} opts.room      room code
     * @param {string} opts.session   reconnect session id
     * @param {string} opts.name      display name
     * @param {object} opts.params    extra connect params (size, seed, pool, color)
     * @param {object} opts.faultControl  shared fault config/state (fault-injector)
     * @param {number} [opts.settleMs]
     * @param {boolean} [opts.hidden]  run as a backgrounded tab (default true)
     * @param {(o:object)=>void} opts.emit  ship lifecycle/frame/observation events out
     */
    constructor(opts) {
        this.opts = opts;
        this.hidden = opts.hidden !== false;
        this.emit = opts.emit;
        this.strictness = opts.strictness || 'eventual';
        this.convergenceFrames = opts.convergenceFrames ?? 3;
        // Macrotask ticks to wait for the online driver's promise chain to drain
        // after a frame (hidden-mode animations resolve on microtasks, so a few
        // ticks reliably settle a frame's NET_* commands).
        this.flushTicks = opts.flushTicks ?? 4;
        this.reproWindow = opts.reproWindow ?? 12;

        this.seat = -1;
        this.isHost = false;
        this._started = false;
        this._ended = false;
        this._endScheduled = false;
        this._seq = 0;
        this._latestServer = null;
        this._lastReason = null;
        this._lastType = null;

        // Per-frame sampling: a serialized pump processes one frame fully (delta
        // replay + reconcile) before the next, so each sample pairs cleanly with
        // its server frame. A mismatch is only CONFIRMED once its signature
        // persists `convergenceFrames` samples (transient lead/lag on
        // three-sixes / no-move frames heals on the next frame and is ignored).
        this._queue = [];
        this._pumping = false;
        this._tracker = new DesyncTracker({ strictness: this.strictness, convergenceFrames: this.convergenceFrames });
        this._recent = [];               // rolling repro window
    }

    async boot() {
        this._installGlobals();
        // Mute BEFORE importing app modules — audio.js reads localStorage at load.
        globalThis.localStorage.setItem('sound-muted', 'true');

        // The fault-injecting transport. NetClient reads the GLOBAL WebSocket at
        // connect time (and again on each reconnect), so install it now.
        globalThis.WebSocket = makeFaultyWebSocket(WsImpl, this.opts.faultControl);

        // Dynamic import AFTER globals/fixture so module-load-time DOM/localStorage
        // reads see the realm. Importing online-game pulls in game-store +
        // command-handler, whose `../index.js` barrel auto-wires setCommandHandler
        // and the listeners (bot-listener stays inert online with assists off).
        const [netClientMod, onlineGameMod, onlineStateMod, gameStateMod, gameStoreMod, renderMod] =
            await Promise.all([
                import(srcUrl('scripts/net/net-client.js')),
                import(srcUrl('scripts/net/online-game.js')),
                import(srcUrl('scripts/net/online-state.js')),
                import(srcUrl('scripts/state/game-state.js')),
                import(srcUrl('scripts/state/game-store.js')),
                import(srcUrl('scripts/render/render-logic.js')),
            ]);

        this._handleOnlineMessage = onlineGameMod.handleOnlineMessage;
        this._startOnlineGame = onlineGameMod.startOnlineGame;
        this._state = gameStateMod.state;
        this._getTurnCount = renderMod.getTurnCount;
        this._toServer = onlineStateMod.toServer;
        this._onlineSeat = onlineStateMod.onlineSeat;

        this.client = new netClientMod.NetClient({
            url: this.opts.url,
            room: this.opts.room,
            session: this.opts.session,
            name: this.opts.name,
            params: this.opts.params,
            onMessage: (m) => this._onMessage(m),
            onReconnecting: (n, max) => this.emit({ type: 'reconnecting', attempt: n, max }),
            onReconnected: () => this.emit({ type: 'reconnected' }),
            onGiveUp: () => this.emit({ type: 'giveup' }),
            onClose: () => { /* close lifecycle handled at teardown */ },
        });
        this.client.connect();
    }

    // ----- intents driven by the GameRunner -----
    start() { try { this.client?.start(); } catch (e) { /* not host / not in lobby */ } }
    roll() { try { this.client?.roll(); } catch (e) { /* socket may be mid-reconnect */ } }
    move(token) { try { this.client?.move(token); } catch (e) { /* ditto */ } }
    forceReconnect() { try { this.opts.faultControl.current?.forceDrop(); } catch { /* ignore */ } }
    close() { try { this.client?.close(); } catch { /* ignore */ } }

    // ----- inbound server frames -----
    _onMessage(msg) {
        if (msg.t === 'seated') {
            this.seat = msg.playerIndex;
            this.isHost = !!msg.isHost;
            this.emit({ type: 'seated', seat: this.seat, isHost: this.isHost, roomId: msg.roomId });
            return;
        }
        if (msg.t === 'busy') { this.emit({ type: 'busy', reason: msg.reason }); return; }
        if (msg.t === 'kicked') { this.emit({ type: 'kicked' }); return; }
        if (msg.t === 'rejected' || msg.t === 'error') {
            this.emit({ type: 'rejected', error: msg.error });
            return;
        }

        // Lobby phase: surface the lobby snapshot (the GameRunner decides when the
        // host starts), and hand off to the real board on the first started frame.
        if (!this._started) {
            if (msg.t === 'state' && msg.state) {
                if (msg.state.started) {
                    this._started = true;
                    this._startOnlineGame({ net: this.client, seat: this.seat, state: msg.state });
                    this.emit({ type: 'started', seat: this.seat, server: msg.state });
                    // Fall through so the started frame is also recorded/sampled.
                } else {
                    this.emit({ type: 'lobby', seat: this.seat, server: lobbyView(msg.state) });
                    return;
                }
            } else {
                return;
            }
        }

        // In-game frame: queue for serialized processing (one frame fully replays
        // + reconciles before the next, so each client sample pairs with its frame).
        this._queue.push(msg);
        this._pump();
    }

    async _pump() {
        if (this._pumping) return;
        this._pumping = true;
        try {
            while (this._queue.length) {
                const msg = this._queue.shift();
                await this._processFrame(msg);
            }
        } finally {
            this._pumping = false;
        }
    }

    async _processFrame(msg) {
        this._seq++;
        this._latestServer = msg.state || this._latestServer;
        this._lastReason = msg.reason || (msg.t === 'moved' ? 'moved' : null);
        this._lastType = msg.t;
        this._shipFrame(msg);

        try {
            this._handleOnlineMessage(msg);
        } catch (e) {
            this.emit({ type: 'pipeline-error', message: String((e && e.stack) || e), seq: this._seq });
        }

        await this._flush();

        this._sampleAndCompare();

        // Game over: wait a grace exceeding any fault delay so trailing throttled/
        // delayed frames flush, THEN do the authoritative final comparison. This
        // keeps timing faults (which never lose data) from forging an end-desync,
        // while a truly lost final move still fails the final check.
        const sawEnd = msg.t === 'ended' || msg.state?.phase === 'ENDED';
        if (sawEnd && !this._endScheduled) {
            this._endScheduled = true;
            setTimeout(() => this._finalCheck(), this._endGraceMs());
        }
    }

    /** Wait for the online driver's promise chain to drain after this frame. */
    async _flush() {
        for (let i = 0; i < this.flushTicks; i++) {
            await new Promise((r) => setTimeout(r, 0));
        }
    }

    /** Compact per-frame server record (cheap). Carries the ACTING seat's tokens
     *  (curPos) so the GameRunner can dedup drive actions across "play again"
     *  rounds, which keep the same turn count but a changed board. */
    _shipFrame(msg) {
        const s = msg.state;
        const cur = s?.currentPlayerIndex;
        this.emit({
            type: 'frame',
            seq: this._seq,
            seat: this.seat,
            t: msg.t,
            reason: this._lastReason,
            turn: s?.turn,
            cur,
            dice: s?.dice,
            phase: s?.phase,
            legalMoves: s?.legalMoves,
            curPos: (cur != null && s?.positions?.[cur]) ? s.positions[cur].slice() : null,
        });
    }

    /** Build the {server, client} observation pair from the current belief. */
    _buildObs() {
        const st = this._state;
        // Recover this client's local→seat mapping from ITS OWN online-state, so a
        // mapping that itself desynced still shows what this client would render.
        const localToSeat = [this._toServer(0), this._toServer(1), this._toServer(2), this._toServer(3)];
        const client = {
            seat: this.seat,
            localToSeat,
            currentPlayerIndexLocal: st.currentPlayerIndex,
            turnCountDisplayed: this._getTurnCount(),   // the "Turn N" the user sees
            turnCountState: st.turnCount,               // reducer's own tally
            dice: st.currentDiceRoll,
            phase: st.phase,
            positionsLocal: st.playerTokenPositions.map((p) => (p ? p.slice() : null)),
        };
        return { server: this._latestServer, client };
    }

    _shipDesync(obs, rec, atEnd) {
        this.emit({
            type: 'desync', seat: this.seat, seq: this._seq, sig: `${rec.mismatch.field}:${rec.mismatch.seat ?? ''}`,
            persisted: rec.persisted, atEnd, reason: this._lastReason,
            mismatch: rec.mismatch, allMismatches: rec.allMismatches,
            server: compactServer(obs.server), client: obs.client, recent: this._recent.slice(),
        });
    }

    /** Per-frame sample + compare via the shared DesyncTracker, which confirms a
     *  mismatch only once it persists convergenceFrames frames (transient
     *  lead/lag heals and is ignored). */
    _sampleAndCompare() {
        if (!this._latestServer) return;
        const obs = this._buildObs();
        this._recent.push({ seq: this._seq, reason: this._lastReason, server: compactServer(obs.server), client: obs.client });
        if (this._recent.length > this.reproWindow) this._recent.shift();
        for (const rec of this._tracker.observe(obs)) this._shipDesync(obs, rec, false);
    }

    /** Authoritative end-of-game comparison, after a grace for trailing frames.
     *  Any mismatch that survives the grace is a real, permanent end desync. */
    _finalCheck() {
        this._ended = true;
        if (this._latestServer) {
            const obs = this._buildObs();
            for (const rec of this._tracker.finalize(obs)) this._shipDesync(obs, rec, true);
        }
        this.emit({ type: 'ended', seq: this._seq });
    }

    /** End grace must exceed any in-flight fault delay so trailing frames arrive. */
    _endGraceMs() {
        const f = this.opts.faultControl?.config || {};
        return Math.max(150, (f.throttle?.batchMs || 0) + (f.delayMs || 0) + 150);
    }

    _installGlobals() {
        const win = new Window({ url: 'http://localhost/', settings: { disableJavaScriptFileLoading: true, disableCSSFileLoading: true } });
        const doc = win.document;

        // Several of these (navigator, performance) are read-only getters on the
        // Node global, so assignment throws — define them instead.
        const set = (key, value) => {
            try { globalThis[key] = value; }
            catch { Object.defineProperty(globalThis, key, { configurable: true, writable: true, value }); }
        };

        set('window', win);
        set('document', doc);
        set('navigator', win.navigator);
        set('location', win.location);
        set('history', win.history);
        set('localStorage', win.localStorage);
        set('sessionStorage', win.sessionStorage);
        set('customElements', win.customElements);
        set('HTMLElement', win.HTMLElement);
        set('CustomEvent', win.CustomEvent);
        set('Event', win.Event);
        set('getComputedStyle', win.getComputedStyle.bind(win));
        set('requestAnimationFrame', (cb) => setTimeout(() => cb(Date.now()), 0));
        set('cancelAnimationFrame', (id) => clearTimeout(id));
        if (typeof globalThis.matchMedia !== 'function' && typeof win.matchMedia !== 'function') {
            win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
        }
        // Belt-and-suspenders: audio is muted so these never run, but a stray
        // AudioContext access must not throw the whole realm.
        if (typeof globalThis.AudioContext !== 'function') {
            set('AudioContext', class { constructor() { this.state = 'running'; } resume() {} createOscillator() { return noopNode(); } createGain() { return noopNode(); } createBiquadFilter() { return noopNode(); } createBufferSource() { return noopNode(); } createBuffer() { return { getChannelData: () => new Float32Array(1) }; } get destination() { return noopNode(); } get currentTime() { return 0; } get sampleRate() { return 44100; } });
        }

        installDomFixture(win);
        if (this.hidden) {
            try {
                Object.defineProperty(doc, 'hidden', { configurable: true, get: () => true });
                Object.defineProperty(doc, 'visibilityState', { configurable: true, get: () => 'hidden' });
            } catch { /* some DOM impls lock these — non-fatal */ }
        }
    }
}

/** Strip a server snapshot to the fields the comparator + repro need. */
function compactServer(s) {
    if (!s) return null;
    return {
        phase: s.phase, turn: s.turn, currentPlayerIndex: s.currentPlayerIndex,
        dice: s.dice, legalMoves: s.legalMoves, positions: s.positions,
        playerTypes: s.playerTypes, ranks: s.ranks,
    };
}

/** Trimmed lobby snapshot for the GameRunner's start decision. */
function lobbyView(state) {
    return {
        started: state.started,
        hostSeat: state.hostSeat,
        size: state.size,
        seats: state.seats,
        playerTypes: state.playerTypes,
    };
}

function noopNode() {
    return new Proxy(function () {}, {
        get(_t, k) {
            if (k === 'gain' || k === 'frequency' || k === 'detune' || k === 'Q') return { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} };
            return () => noopNode();
        },
        apply() { return noopNode(); },
    });
}
