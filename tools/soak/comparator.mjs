/**
 * Comparator — does ONE client's settled belief line up with the server?
 *
 * Server state is SEAT-indexed (seat 0..3 = colour/turn-order). Client state is
 * LOCAL board-indexed (the client always renders itself bottom-right; ≤2-player
 * games use a diagonal re-seat, NOT a pure rotation — see online-state.js). So we
 * project the client back into seat space using the client's OWN local→seat map
 * (`localToSeat[localIndex] = toServer(localIndex)`), then compare like-for-like.
 * Using the client's own mapping means a mapping that itself drifted still shows
 * what the client would actually render.
 *
 * Pure + synchronous so it's unit-testable and cheap to run on every observation.
 */

export const STRICTNESS = Object.freeze({
    STRICT: 'strict',                 // positions + turn + currentPlayer + phase + dice
    POSITIONS_ONLY: 'positions-only', // positions + turn only (the desync core)
    EVENTUAL: 'eventual',             // same fields as strict; persistence handled by caller
});

// Server PHASES (room-engine) → client PHASES (game-state). Names differ.
const PHASE_MAP = Object.freeze({
    AWAIT_ROLL: 'AWAITING_ROLL',
    AWAIT_MOVE: 'AWAITING_SELECTION',
    ENDED: 'GAME_ENDED',
    LOBBY: null,
});

// Client phases that mean "still mid-processing this frame", not a settled state.
// A sample caught here is in flight (more common in a real browser than in the
// fast-forwarded worker) — it settles on the next frame, so it's not a desync.
const TRANSIENT_CLIENT_PHASES = new Set(['ROLLING', 'ANIMATING', 'TURN_TRANSITION']);

function arraysEqual(a, b) {
    if (a === b) return true;
    if (!a || !b || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

/** Project a client sample's local-indexed fields into seat space. */
export function toSeatSpace(client) {
    const map = client.localToSeat || [0, 1, 2, 3];
    const positionsBySeat = [null, null, null, null];
    for (let local = 0; local < 4; local++) {
        const seat = map[local];
        if (seat >= 0 && seat < 4) positionsBySeat[seat] = client.positionsLocal?.[local] ?? null;
    }
    const currentSeat = map[client.currentPlayerIndexLocal];
    return { positionsBySeat, currentSeat };
}

/**
 * Compare one observation. Returns { ok, mismatches:[{field, severity, seat?,
 * server, client}], normalized }. The caller (GameRunner/reporter) applies
 * strictness/eventual policy to decide pass/fail; this just reports raw diffs.
 *
 * @param {{server:object, client:object}} obs
 */
export function compareObservation(obs) {
    const { server, client } = obs;
    const { positionsBySeat, currentSeat } = toSeatSpace(client);
    const mismatches = [];

    // 1. Positions per active seat (severity: core — this is what the bug breaks).
    for (let seat = 0; seat < 4; seat++) {
        const sv = server.positions?.[seat] ?? null;
        const cl = positionsBySeat[seat] ?? null;
        const sActive = sv != null;
        const cActive = cl != null;
        if (sActive && cActive) {
            if (!arraysEqual(sv, cl)) {
                mismatches.push({ field: 'positions', severity: 'core', seat, server: sv, client: cl });
            }
        } else if (sActive !== cActive) {
            // One side thinks the seat is in play and the other doesn't — a drop /
            // finish that only one side applied. Lower severity (it converges via
            // NET_DROP_PLAYER / NET_END), but still reported.
            mismatches.push({ field: 'activation', severity: 'aux', seat, server: sActive, client: cActive });
        }
    }

    // 2. Turn count — the headline symptom (the displayed "Turn N").
    if (server.turn !== client.turnCountDisplayed) {
        mismatches.push({ field: 'turn', severity: 'core', server: server.turn, client: client.turnCountDisplayed });
    }

    // 3. Whose turn it is (seat space).
    if (server.currentPlayerIndex !== currentSeat) {
        mismatches.push({ field: 'currentPlayer', severity: 'core', server: server.currentPlayerIndex, client: currentSeat });
    }

    // 4. Phase (mapped). Skip while server is mid-lobby, and skip when the client
    //    is in a transient (mid-frame) phase that hasn't settled yet.
    const expectedClientPhase = PHASE_MAP[server.phase];
    if (expectedClientPhase && client.phase !== expectedClientPhase && !TRANSIENT_CLIENT_PHASES.has(client.phase)) {
        mismatches.push({ field: 'phase', severity: 'aux', server: server.phase, client: client.phase });
    }

    // 5. Dice — only meaningful while a roll is live (AWAIT_MOVE). On AWAIT_ROLL the
    //    server zeroes dice but the client keeps the last face, so don't compare.
    if (server.phase === 'AWAIT_MOVE' && server.dice !== client.dice) {
        mismatches.push({ field: 'dice', severity: 'aux', server: server.dice, client: client.dice });
    }

    return {
        ok: mismatches.length === 0,
        mismatches,
        normalized: { positionsBySeat, currentSeat },
    };
}

/** Which mismatch fields count as a failure under a strictness mode. */
export function failingMismatches(mismatches, strictness) {
    if (strictness === STRICTNESS.POSITIONS_ONLY) {
        return mismatches.filter((m) => m.field === 'positions' || m.field === 'turn');
    }
    // strict + eventual weigh every field; eventual's persistence is applied by
    // the DesyncTracker across consecutive observations.
    return mismatches.slice();
}

/** Stable signature for a mismatch so persistence is tracked per field+seat. */
export function sigOf(m) {
    return `${m.field}:${m.seat ?? ''}`;
}

/**
 * Tracks mismatch persistence across a stream of per-frame observations so only a
 * desync that DOESN'T heal is confirmed. Transient lead/lag (the client running
 * ahead on a three-sixes / no-move frame, then reconverging) clears on the next
 * frame and never reaches the convergence threshold. Shared by the worker harness
 * and the browser backend so both confirm identically.
 */
export class DesyncTracker {
    constructor({ strictness = STRICTNESS.EVENTUAL, convergenceFrames = 3 } = {}) {
        this.strictness = strictness;
        this.convergenceFrames = convergenceFrames;
        this._count = new Map();     // signature → consecutive count
        this._reported = new Set();  // signatures already confirmed
    }

    /** Feed one observation. Returns newly-confirmed records (each { mismatch,
     *  persisted, allMismatches }) — empty in the common (healthy) case. */
    observe(obs) {
        const failing = failingMismatches(compareObservation(obs).mismatches, this.strictness);
        const present = new Set(failing.map(sigOf));
        const out = [];
        for (const m of failing) {
            const sig = sigOf(m);
            const count = (this._count.get(sig) || 0) + 1;
            this._count.set(sig, count);
            if (count >= this.convergenceFrames && !this._reported.has(sig)) {
                this._reported.add(sig);
                out.push({ mismatch: m, persisted: count, allMismatches: failing });
            }
        }
        for (const sig of this._count.keys()) {
            if (!present.has(sig)) { this._count.delete(sig); this._reported.delete(sig); }
        }
        return out;
    }

    /** Authoritative final comparison: confirm any surviving mismatch regardless
     *  of persistence (there's no next frame to heal it). */
    finalize(obs) {
        const failing = failingMismatches(compareObservation(obs).mismatches, this.strictness);
        const out = [];
        for (const m of failing) {
            const sig = sigOf(m);
            if (!this._reported.has(sig)) {
                this._reported.add(sig);
                out.push({ mismatch: m, persisted: 'final', allMismatches: failing });
            }
        }
        return out;
    }
}
