// Path data for the compact 32-viewBox pawn — the SMALL pawn used by the home/
// lobby chip (wc-icons PAWN_SVG), the pause scoreboard (render-logic) and the
// end-game recap (wc-game-end, both the DOM card and the canvas share image).
// Distinct from the larger 0 0 100 116 board/overlay pawn in pawn-shape.js.
//
// miniPawnSVG() is the one parameterized builder for all four call sites,
// configured with fill source (CSS class vs explicit colour), shadow ellipse
// presence and opacity, and highlight layers. Centralised so the silhouette
// can't drift between the chip, the scoreboard and the recap.
export const MINI_PAWN_BODY =
    'M16 4c3.2 0 5.5 2.4 5.5 5.2 0 1.8-1 3.2-2.4 4 1.7.7 2.9 1.8 3.6 3.4l1.1 2.6c.4 1 .1 2-.7 2.4-.2.1-.4.1-.6.1H9.5c-.9 0-1.6-.7-1.6-1.6 0-.3.1-.6.2-.9l1.1-2.6c.7-1.6 1.9-2.7 3.6-3.4-1.4-.8-2.4-2.2-2.4-4C10.4 6.4 12.8 4 16 4z';

export const MINI_PAWN_HIGHLIGHT =
    'M16 4c3.2 0 5.5 2.4 5.5 5.2 0 1.8-1 3.2-2.4 4-.6-.3-1.3-.5-2-.5h-2.2c-.7 0-1.4.2-2 .5-1.4-.8-2.4-2.2-2.4-4C10.4 6.4 12.8 4 16 4z';

/**
 * Parameterized mini-pawn SVG builder. Renders a 32×32 viewBox pawn with
 * configurable fill (CSS class or explicit colour), shadow ellipse, and
 * highlight layers. Each call site passes the layers + styles it renders today.
 *
 * @param {Object} opts
 * @param {number|null} [opts.playerIndex=null] - Sets class="player-fg-N" and uses currentColor fills
 * @param {string} [opts.fill='currentColor'] - Explicit colour for class-less use (canvas rendering)
 * @param {string} [opts.style=''] - Inline style (size, drop-shadow, etc.)
 * @param {boolean} [opts.xmlns=false] - Add xmlns attr for standalone SVG (blob/canvas)
 * @param {number|null} [opts.width=null] - Explicit width attr for canvas rasterisation
 * @param {number|null} [opts.height=null] - Explicit height attr for canvas rasterisation
 * @param {number|null} [opts.shadow=null] - Ground-ellipse opacity (null = omit ellipse)
 * @param {boolean} [opts.highlight=false] - Include highlight path + base-highlight rect
 * @returns {string} SVG markup
 */
export function miniPawnSVG({
    playerIndex = null,
    fill = 'currentColor',
    style = '',
    xmlns = false,
    width = null,
    height = null,
    shadow = null,
    highlight = false,
}) {
    const attrs = [];
    attrs.push('viewBox="0 0 32 32"');
    if (xmlns) attrs.push('xmlns="http://www.w3.org/2000/svg"');
    if (playerIndex !== null) {
        attrs.push(`class="player-fg-${playerIndex}"`);
    }
    if (width !== null) attrs.push(`width="${width}"`);
    if (height !== null) attrs.push(`height="${height}"`);
    if (style) attrs.push(`style="${style}"`);

    const bodyFill = playerIndex !== null ? 'currentColor' : fill;
    const highlightFill = 'rgba(255,255,255,0.24)';
    const baseFill = playerIndex !== null ? 'currentColor' : fill;
    const baseHighlightFill = 'rgba(255,255,255,0.38)';

    let svg = `<svg ${attrs.join(' ')}>`;

    if (shadow !== null) {
        svg += `<ellipse cx="16" cy="28" rx="8" ry="1.5" fill="rgba(0,0,0,${shadow})"/>`;
    }

    svg += `<path d="${MINI_PAWN_BODY}" fill="${bodyFill}"/>`;

    if (highlight) {
        svg += `<path d="${MINI_PAWN_HIGHLIGHT}" fill="${highlightFill}"/>`;
    }

    svg += `<rect x="7.5" y="22" width="17" height="3.5" rx="1.4" fill="${baseFill}"/>`;

    if (highlight) {
        svg += `<rect x="7.5" y="22" width="17" height="1.2" rx="0.6" fill="${baseHighlightFill}"/>`;
    }

    svg += '</svg>';

    return svg;
}
