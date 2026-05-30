/**
 * Pause-aware setTimeout queue. Extracted from the old game-events.js +
 * command-handler.js. Owns the single-slot pending-resume continuation
 * semantics: pausing while a timer is in flight stashes the callback for
 * resume to fire later.
 */

let _paused = false;
let _pendingResume = null;
const _pendingTimers = new Map();

export function isGameLogicPaused() { return _paused; }

export function scheduleTurn(fn, delay) {
    if (_paused) { _pendingResume = fn; return; }
    const id = setTimeout(() => {
        _pendingTimers.delete(id);
        if (_paused) { _pendingResume = fn; return; }
        fn();
    }, delay);
    _pendingTimers.set(id, fn);
}

export function pauseGameLogic() {
    _paused = true;
    for (const [id, fn] of _pendingTimers) {
        clearTimeout(id);
        _pendingResume = fn;
    }
    _pendingTimers.clear();
}

export function resumeGameLogic() {
    _paused = false;
    const fn = _pendingResume;
    _pendingResume = null;
    if (fn) fn();
}

export function _scheduleTurnForTest(fn, delay) { return scheduleTurn(fn, delay); }

// Test-only: clear all scheduler state (in-flight timers, stashed resume
// continuation, paused flag) so suites don't leak timers across cases.
export function _resetSchedulerForTest() {
    for (const id of _pendingTimers.keys()) clearTimeout(id);
    _pendingTimers.clear();
    _pendingResume = null;
    _paused = false;
}
