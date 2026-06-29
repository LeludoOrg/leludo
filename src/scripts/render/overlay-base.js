// Shared scaffolding for the gameplay FX overlays (pawn-launch, ko-capture,
// pawn-step). Each overlay keeps its own prefixed CSS and animation tuning;
// this module owns the boilerplate all three repeated: the style-injection
// guard, the absolutely-positioned root layer, the cleanup timer, the
// parabolic-arc helper, and the shared easing/timing constants. The pawn glyph
// they also share lives in pawn-shape.js.

export const OVERLAY_Z = 1000;          // overlay layer, above the board
export const CLEANUP_MARGIN_MS = 80;    // grace after the last animation before removal

// Named easings shared across overlays — documents intent and prevents drift.
export const EASE_SETTLE = 'cubic-bezier(.3, 1.6, .4, 1)'; // bouncy land / squash settle
export const EASE_BURST  = 'cubic-bezier(.2, .7, .3, 1)';  // ring / confetti / dust spray

/** Create a class'd <div>, optionally with inline cssText. */
export function el(cls, css) {
    const d = document.createElement('div');
    d.className = cls;
    if (css) d.style.cssText = css;
    return d;
}

/** CSS for an overlay's root layer. Interpolate into each overlay's stylesheet
 *  so the absolute / inset / pointer-events / z-index / overflow rules — which
 *  every overlay declared identically — live in exactly one place. */
export function overlayRootCSS(rootClass) {
    return `
      .${rootClass} {
        position: absolute; inset: 0;
        pointer-events: none;
        z-index: ${OVERLAY_Z};
        overflow: visible;
      }`;
}

/** Inject a <style> once per id (no-op if already present). */
export function injectOnce(id, cssText) {
    if (document.getElementById(id)) return;
    const style = document.createElement('style');
    style.id = id;
    style.textContent = cssText;
    document.head.appendChild(style);
}

/** Create + append the overlay root layer; returns the element. */
export function createOverlayRoot(container, rootClass) {
    const root = el(rootClass);
    container.appendChild(root);
    return root;
}

// --- Finish-now registry ---------------------------------------------------
// Gameplay FX (pawn hop / launch / capture) animate on their own rAF + Web
// Animations timeline, independent of the turn scheduler. When the game pauses
// mid-animation we don't want a pawn frozen halfway through its hop under the
// pause card — so each running overlay registers a `finisher` that snaps it to
// its end frame (pawn on its destination cell, firing its onArrive handoff).
// handleGamePause calls finishActiveOverlays() to drain them before the pause
// overlay appears. Each overlay unregisters its finisher in its own teardown.
const _activeFinishers = new Set();

/** Register an overlay's "jump to end" callback. Returns an unregister fn the
 *  overlay MUST call from its own cleanup so a completed overlay isn't finished
 *  a second time. */
export function registerOverlayFinisher(finisher) {
    _activeFinishers.add(finisher);
    return () => _activeFinishers.delete(finisher);
}

/** Snap every in-flight FX overlay to its final frame, immediately. Safe to
 *  call when nothing is animating (no-op). We drain only the finishers present
 *  when called: a snap's onArrive handoff can register a NEW overlay (e.g. a
 *  capture KO) mid-loop, and that one should keep playing, not be force-ended. */
export function finishActiveOverlays() {
    if (_activeFinishers.size === 0) return;
    const snapshot = [..._activeFinishers];
    for (const finisher of snapshot) {
        _activeFinishers.delete(finisher);
        try { finisher(); } catch { /* a wedged finisher must not block the pause */ }
    }
}

/** Remove `root` after `ms`, fire `onComplete`, resolve. The standard overlay
 *  teardown — callers add CLEANUP_MARGIN_MS to their animation length. */
export function scheduleCleanup(root, ms, onComplete) {
    return new Promise(resolve => {
        setTimeout(() => {
            if (root.parentNode) root.parentNode.removeChild(root);
            if (onComplete) onComplete();
            resolve();
        }, ms);
    });
}

/** Inline CSS for a `w`×`h` box centred on (x, y), with optional vertical
 *  offset `dy` added to the top (e.g. to drop FX to a pawn's feet). Collapses
 *  the left/top/width/height string every overlay hand-built per sprite. `h`
 *  defaults to `w` for square sprites. Callers append any extra rules (color,
 *  background) after it. */
export function boxAt(x, y, w, h = w, dy = 0) {
    return `left:${x - w / 2}px;top:${y - h / 2 + dy}px;width:${w}px;height:${h}px;`;
}

/** Point on a parabolic arc from→to at t∈[0,1], rising `apex` px above the
 *  straight line at the midpoint. Shared by every overlay's leap / throw / hop. */
export function arcPoint(from, to, t, apex) {
    return {
        x: from.x + (to.x - from.x) * t,
        y: from.y + (to.y - from.y) * t - apex * 4 * t * (1 - t),
    };
}
