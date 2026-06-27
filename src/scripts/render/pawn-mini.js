// Path data for the compact 32-viewBox pawn — the SMALL pawn used by the home/
// lobby chip (wc-icons PAWN_SVG), the pause scoreboard (render-logic) and the
// end-game recap (wc-game-end, both the DOM card and the canvas share image).
// Distinct from the larger 0 0 100 116 board/overlay pawn in pawn-shape.js.
//
// Only the two path strings are shared here; each surface keeps its own <svg>
// wrapper because they legitimately differ in fill source (CSS class vs explicit
// colour), base-shadow ellipse and rect highlight layers. Centralised so the
// silhouette can't drift between the chip, the scoreboard and the recap.
export const MINI_PAWN_BODY =
    'M16 4c3.2 0 5.5 2.4 5.5 5.2 0 1.8-1 3.2-2.4 4 1.7.7 2.9 1.8 3.6 3.4l1.1 2.6c.4 1 .1 2-.7 2.4-.2.1-.4.1-.6.1H9.5c-.9 0-1.6-.7-1.6-1.6 0-.3.1-.6.2-.9l1.1-2.6c.7-1.6 1.9-2.7 3.6-3.4-1.4-.8-2.4-2.2-2.4-4C10.4 6.4 12.8 4 16 4z';

export const MINI_PAWN_HIGHLIGHT =
    'M16 4c3.2 0 5.5 2.4 5.5 5.2 0 1.8-1 3.2-2.4 4-.6-.3-1.3-.5-2-.5h-2.2c-.7 0-1.4.2-2 .5-1.4-.8-2.4-2.2-2.4-4C10.4 6.4 12.8 4 16 4z';
