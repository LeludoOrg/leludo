// Shared pawn geometry + SVG builder. This is the ONE source for the pawn
// glyph: the on-board wc-token AND the gameplay overlays (pawn-launch,
// ko-capture, pawn-step) all build their pawn from here, so the shape can
// never drift between the board and the FX that fly across it.
//
// A top-heavy matte chess-pawn: sphere head, slim waist, flared base, drawn in
// a 0 0 100 116 viewBox (taller than wide — the contact point is bottom-center).
// The body + head carry a near-black contour (the theme-tuned --pawn-outline
// token, same hue for every player) so a resting pawn reads distinct from its
// same-colour yard ring; the base disc the pawn stands on is its own colour with
// a soft black overlay, the collar keeps a colour-mixed edge, and the sheen is a
// colour-independent white gradient. Each overlay's drop-shadow lives in its own
// CSS via the `svgClass` it passes.

export const PAWN_VIEWBOX = '0 0 100 116';
export const PAWN_ASPECT = 1.16;            // height = width * 1.16
export const PAWN_BODY =
    'M30 100 Q22 84 33 60 Q40 49 41 41 L59 41 Q60 49 67 60 Q78 84 70 100 Z';

// Stroke / base-disc shade derived from the base fill — one matte step toward
// black. Works with any CSS color, including `currentColor` (so wc-token can
// stay driven by its player-fg class + runtime applyColorMap remap).
function darkOf(color) {
    return `color-mix(in srgb, ${color} 64%, #000)`;
}

let _gradUid = 0;

// Build the layered pawn <svg>.
//   color     base fill — concrete CSS color OR 'currentColor'
//   size      px WIDTH of the pawn (height = size * PAWN_ASPECT). Ignored when
//             opts.fill. Width is the reference dimension so an overlay pawn
//             matches the on-board wc-token, which is width-driven (its svg is
//             width:100% of the cell); the overlays pass measured token WIDTHS
//             as `size` + an endScale on widths, so both ends line up — no pop.
//   svgClass  class(es) on the <svg> — selects drop-shadow CSS, carries the
//             player-fg-N class for currentColor-driven tokens.
//   uidPrefix namespaces this instance's gradient id.
//   opts.flat single-fill silhouette (launch-trail ghosts) — no sheen/stroke.
//   opts.fill omit width/height so CSS sizes the svg (used by wc-token).
export function pawnSVG(color, size, svgClass, uidPrefix, opts) {
    const fill = opts && opts.fill;
    const dims = fill
        ? ''
        : ` width="${size}" height="${size * PAWN_ASPECT}"`;
    const open =
        '<svg class="' + svgClass + '" viewBox="' + PAWN_VIEWBOX + '"' + dims + '>';

    if (opts && opts.flat) {
        return (
            open +
                '<ellipse cx="50" cy="101" rx="26" ry="6.5" style="fill:' + color + '"/>' +
                '<path d="' + PAWN_BODY + '" style="fill:' + color + '"/>' +
                '<circle cx="50" cy="24" r="20" style="fill:' + color + '"/>' +
            '</svg>'
        );
    }

    const uid = uidPrefix + (++_gradUid);
    const dark = darkOf(color);
    const sheen = 'url(#' + uid + 's)';
    return (
        open +
            '<defs>' +
                '<linearGradient id="' + uid + 's" x1="0.3" y1="0" x2="0.55" y2="0.62">' +
                    '<stop offset="0%" stop-color="#fff" stop-opacity="0.26"/>' +
                    '<stop offset="62%" stop-color="#fff" stop-opacity="0"/>' +
                '</linearGradient>' +
            '</defs>' +
            // base disc the pawn stands on — own colour + soft dark overlay
            '<ellipse cx="50" cy="101" rx="26" ry="6.5" style="fill:' + color + '"/>' +
            '<ellipse cx="50" cy="101" rx="26" ry="6.5" style="fill:#000;opacity:0.1"/>' +
            // body
            '<path d="' + PAWN_BODY + '" style="fill:' + color + ';stroke:var(--pawn-outline);stroke-width:var(--pawn-outline-w)"/>' +
            '<path d="' + PAWN_BODY + '" style="fill:' + sheen + '"/>' +
            // collar
            '<ellipse cx="50" cy="41" rx="15" ry="4.6" style="fill:' + color + ';stroke:' + dark + ';stroke-width:1"/>' +
            // head
            '<circle cx="50" cy="24" r="20" style="fill:' + color + ';stroke:var(--pawn-outline);stroke-width:var(--pawn-outline-w)"/>' +
            '<circle cx="50" cy="24" r="20" style="fill:' + sheen + '"/>' +
        '</svg>'
    );
}
