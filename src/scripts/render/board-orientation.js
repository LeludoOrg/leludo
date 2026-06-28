// Board orientation for local pass-and-play.
//
// When two people share one phone, the player sitting opposite reads the board
// upside-down. This module rotates the whole play area (the .board-rotor wrapper
// — corner name plates, dice, and the grid) 180° on each turn so the active
// player's home corner faces them. It's deliberately scoped to the clean
// face-to-face case: exactly two humans seated on opposite halves of the board,
// offline. Online games keep their own per-client seat remap (online-state.js)
// and never use this; solo-vs-bots and 3–4-player games stay un-rotated.
//
// THE COORDINATE PROBLEM. The rotation is a CSS transform on .board-rotor. Every
// gameplay overlay (pawn hop, capture, launch, finish) positions its sprites in
// the board's LOCAL (un-rotated) coordinate space, but it MEASURES cells with
// getBoundingClientRect — which returns the VIEWPORT box of the *rotated*
// element. So a point measured in viewport space must be mapped back into
// board-local space before it's used as an absolute overlay offset
// (boardLocalPoint), and a viewport delta vector must be un-rotated before it's
// used as a FLIP translate that plays inside the rotated rotor (boardUnrotateVec).
//
// At the default 0 quarter-turns both helpers are the identity, so every
// currently-shipping mode (no rotation) is byte-for-byte unchanged — the gate in
// render-logic only ever sets a non-zero rotation for the offline 2-human case.

// Current rotation, in quarter-turns clockwise. Only 0 or 2 are set today; the
// geometry helpers handle 1 and 3 too so the math is complete and testable.
let _quarterTurns = 0;

export function getBoardQuarterTurns() {
    return _quarterTurns;
}

export function setBoardQuarterTurns(q) {
    _quarterTurns = ((q % 4) + 4) % 4;
    return _quarterTurns;
}

/** Rotation to apply to the rotor, in degrees (what the CSS transform uses). */
export function boardRotationDeg() {
    return _quarterTurns * 90;
}

// Map a VIEWPORT point to the board's LOCAL (un-rotated) coordinate space, given
// the rotated SQUARE container's current bounding rect. This is the exact
// inverse of CSS `rotate(quarterTurns*90deg)` about the square's centre, derived
// purely from the live rect's corners — so it's independent of the actual pivot
// (the rotor pivots about its own centre, not the board's, but a rigid 90°/180°
// rotation lands the square axis-aligned either way and we read its real rect).
// Container MUST be square — board-wrap and every cell are.
export function boardLocalPoint(vpX, vpY, rect) {
    const S = rect.width;
    const dx = vpX - rect.left;
    const dy = vpY - rect.top;
    switch (_quarterTurns) {
        case 1: return { x: dy, y: S - dx };
        case 2: return { x: S - dx, y: S - dy };
        case 3: return { x: S - dy, y: dx };
        default: return { x: dx, y: dy };
    }
}

// Map a VIEWPORT delta VECTOR back into board-local space (no origin offset).
// FLIP computes its translate as a difference of two viewport rects, then
// applies it as a transform on an element living inside the rotated rotor — so
// the vector must be un-rotated first, else the rotor's own transform rotates it
// a second time and the token slides the wrong way.
export function boardUnrotateVec(dx, dy) {
    switch (_quarterTurns) {
        case 1: return { x: dy, y: -dx };
        case 2: return { x: -dx, y: -dy };
        case 3: return { x: -dy, y: dx };
        default: return { x: dx, y: dy };
    }
}

// Policy: the quarter-turn that brings the player whose home sits at `homeCorner`
// (0 TL, 1 TR, 2 BR, 3 BL) to the bottom, facing them. v1 only does the clean
// 180° face-to-face flip — a top-half home (TL/TR) rotates 180° to the bottom; a
// bottom-half home is already facing the near player, so it stays put. (A 90°
// turn would swing a portrait board off the side of a phone, so quarter-turns
// are intentionally avoided here.)
export function quarterTurnsToFacePlayer(homeCorner) {
    return (homeCorner === 0 || homeCorner === 1) ? 2 : 0;
}
