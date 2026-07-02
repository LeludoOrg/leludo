/**
 * Pip layout per die face (1..6) on a 3×3 grid, 1-based [row, column] pairs —
 * the CSS-grid convention. Single source of truth for every dice rendering:
 * the live wc-dice faces, the faded corner die (render-logic staticDieMarkup)
 * and the menu DICE_SVG (wc-icons, which converts to 0-based SVG coords).
 */
export const DIE_PIPS = Object.freeze({
    1: [[2, 2]],
    2: [[1, 1], [3, 3]],
    3: [[1, 1], [2, 2], [3, 3]],
    4: [[1, 1], [1, 3], [3, 1], [3, 3]],
    5: [[1, 1], [1, 3], [2, 2], [3, 1], [3, 3]],
    6: [[1, 1], [1, 3], [2, 1], [2, 3], [3, 1], [3, 3]],
});
