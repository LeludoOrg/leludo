// Shared pawn geometry + SVG builder for the gameplay overlays
// (pawn-launch, ko-capture, home-arrival). All three draw the SAME pawn
// as the on-board wc-token — body/head path copied verbatim from
// components/wc-token.js, square 0 0 100 100 viewBox.
//
// Kept in one place so the pawn shape can never drift between overlays.
// Each overlay's drop-shadow lives in its own CSS via the `svgClass` it
// passes here, so per-overlay visual tuning stays local.

export const PAWN_BODY =
    'M32 85 Q30 70 36 55 Q40 45 42 38 L58 38 Q60 45 64 55 Q70 70 68 85 Z';

let _gradUid = 0;

// Build the layered pawn <svg>. `svgClass` selects the overlay's CSS
// (drop-shadow); `uidPrefix` namespaces this instance's gradient ids. Pass
// `{ flat: true }` for a gradient-free single-fill silhouette — used for the
// launch trail ghosts (formerly a hand-copied ghostSVG that could drift).
export function pawnSVG(color, size, svgClass, uidPrefix, opts) {
    if (opts && opts.flat) {
        return (
            '<svg class="' + svgClass + '" viewBox="0 0 100 100" ' +
            'width="' + size + '" height="' + size + '">' +
                '<ellipse cx="50" cy="88" rx="30" ry="8" fill="' + color + '"/>' +
                '<path d="' + PAWN_BODY + '" fill="' + color + '"/>' +
                '<circle cx="50" cy="24" r="16" fill="' + color + '"/>' +
            '</svg>'
        );
    }
    const uid = uidPrefix + (++_gradUid);
    return (
        '<svg class="' + svgClass + '" viewBox="0 0 100 100" ' +
        'width="' + size + '" height="' + size + '">' +
            '<defs>' +
                '<linearGradient id="' + uid + 'b" x1="0.2" y1="0" x2="0.8" y2="1">' +
                    '<stop offset="0%" stop-color="white" stop-opacity="0.35"/>' +
                    '<stop offset="100%" stop-color="black" stop-opacity="0.12"/>' +
                '</linearGradient>' +
                '<radialGradient id="' + uid + 'h" cx="0.4" cy="0.35" r="0.5">' +
                    '<stop offset="0%" stop-color="white" stop-opacity="0.45"/>' +
                    '<stop offset="100%" stop-color="white" stop-opacity="0"/>' +
                '</radialGradient>' +
            '</defs>' +
            '<ellipse cx="50" cy="88" rx="30" ry="8" fill="' + color + '"/>' +
            '<ellipse cx="50" cy="88" rx="30" ry="8" fill="black" opacity="0.1"/>' +
            '<path d="' + PAWN_BODY + '" fill="' + color + '" stroke="white" stroke-width="1.5" stroke-opacity="0.5"/>' +
            '<path d="' + PAWN_BODY + '" fill="url(#' + uid + 'b)"/>' +
            '<ellipse cx="50" cy="38" rx="13" ry="4" fill="' + color + '"/>' +
            '<ellipse cx="50" cy="38" rx="13" ry="4" fill="white" opacity="0.15"/>' +
            '<circle cx="50" cy="24" r="16" fill="' + color + '" stroke="white" stroke-width="1.5" stroke-opacity="0.5"/>' +
            '<circle cx="50" cy="24" r="16" fill="url(#' + uid + 'h)"/>' +
            '<ellipse cx="44" cy="18" rx="5" ry="3.5" fill="white" opacity="0.4" transform="rotate(-20 44 18)"/>' +
        '</svg>'
    );
}
