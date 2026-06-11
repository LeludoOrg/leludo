/**
 * Turn-driving decision, shared by the worker and browser backends. Both drive
 * the human seats off the SERVER frames (the turn authority): roll on our seat's
 * AWAIT_ROLL, pick a move on AWAIT_MOVE with ≥2 options (a single legal move is
 * auto-applied server-side). Bot seats are driven by the server.
 *
 * Signature-based dedup keys on (seat, turn, board) so duplicate frames (every
 * client echoes the same broadcast) don't double-act, while a "play again" round
 * — same turn count, changed board — is correctly treated as a fresh action.
 */
import { pickMove } from './turn-driver.mjs';

export function makeActor(moveRng, movePolicy) {
    const acted = new Set();
    return function decide(frame, ourSeats) {
        if (!ourSeats.has(frame.cur)) return null; // bot seat — server drives it
        const board = frame.curPos ? frame.curPos.join(',') : '';
        if (frame.phase === 'AWAIT_ROLL') {
            const key = `r|${frame.cur}|${frame.turn}|${board}`;
            if (acted.has(key)) return null;
            acted.add(key);
            return { cmd: 'roll' };
        }
        if (frame.phase === 'AWAIT_MOVE') {
            if (!frame.legalMoves || frame.legalMoves.length < 2) return null;
            const key = `m|${frame.cur}|${frame.turn}|${frame.dice}|${board}`;
            if (acted.has(key)) return null;
            acted.add(key);
            const token = pickMove(frame.legalMoves, moveRng, movePolicy);
            return token != null ? { cmd: 'move', token } : null;
        }
        return null;
    };
}
