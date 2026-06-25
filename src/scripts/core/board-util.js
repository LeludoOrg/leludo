/**
 * Shared board-state helpers. No DOM, no globals — pure, tested directly.
 *
 * Cloning the per-player token-position grid (an array of one [t0,t1,t2,t3]
 * row per player, or a falsy slot for an absent player) was copy-pasted in
 * five places — the bot search, the game driver, the save serializer, and the
 * command handler — each subtly disagreeing on what an empty slot becomes.
 * Centralised here so the deep-copy lives in exactly one place.
 */

/**
 * Deep-copy a token-position grid. Each present player's row is `.slice()`d so
 * callers can mutate the copy without touching the source. An absent (falsy)
 * slot is preserved verbatim by default; pass `empty` to coerce every absent
 * slot to that value instead.
 *
 * The serializing callers pass an explicit `empty` so the snapshot shape stays
 * stable (`null` for saved games, `undefined` for the live load path); the bot
 * search omits it to copy verbatim.
 *
 * @param {Array<number[]|null|undefined>} positions
 * @param {null|undefined} [empty] coerce absent slots to this when supplied
 * @returns {Array<number[]|null|undefined>}
 */
export function clonePositions(positions, empty) {
    const coerce = arguments.length > 1;
    const out = new Array(positions.length);
    for (let i = 0; i < positions.length; i++) {
        out[i] = positions[i] ? positions[i].slice() : (coerce ? empty : positions[i]);
    }
    return out;
}
