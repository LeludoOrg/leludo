/**
 * Tiny RNG helpers — one source of truth for the "random element" /
 * "random index" idiom so callers stop hand-rolling
 * `arr[Math.floor(rng() * arr.length)]`. Both accept an injectable rng
 * (defaults to Math.random) so seeded callers stay deterministic.
 */

/**
 * Random integer in [0, n).
 * @param {number} n
 * @param {()=>number} [rng]  returns 0..1
 * @returns {number}
 */
export function randInt(n, rng = Math.random) {
    return Math.floor(rng() * n);
}

/**
 * Random element of `arr`.
 * @template T
 * @param {T[]} arr
 * @param {()=>number} [rng]  returns 0..1
 * @returns {T}
 */
export function pick(arr, rng = Math.random) {
    return arr[randInt(arr.length, rng)];
}
