import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
    acquireInputLock,
    releaseInputLock,
    resetInputLock,
    isInputLocked,
    pauseGameLogic,
    resumeGameLogic,
    isGameLogicPaused,
    _scheduleTurnForTest,
} from '../../scripts/game-events.js';

beforeEach(() => {
    resetInputLock();
    if (isGameLogicPaused()) resumeGameLogic();
});

describe('input lock', () => {
    it('isInputLocked is false by default', () => {
        expect(isInputLocked()).toBe(false);
    });

    it('acquireInputLock + releaseInputLock toggles state', () => {
        acquireInputLock();
        expect(isInputLocked()).toBe(true);
        releaseInputLock();
        expect(isInputLocked()).toBe(false);
    });

    it('nested acquireInputLock requires equal releases', () => {
        acquireInputLock();
        acquireInputLock();
        expect(isInputLocked()).toBe(true);
        releaseInputLock();
        expect(isInputLocked()).toBe(true);
        releaseInputLock();
        expect(isInputLocked()).toBe(false);
    });

    it('releaseInputLock from unlocked state is a no-op (depth never goes negative)', () => {
        releaseInputLock();
        releaseInputLock();
        expect(isInputLocked()).toBe(false);
        acquireInputLock();
        expect(isInputLocked()).toBe(true);
        releaseInputLock();
        expect(isInputLocked()).toBe(false);
    });

    it('resetInputLock zeros depth regardless of how many acquires were pending', () => {
        acquireInputLock();
        acquireInputLock();
        acquireInputLock();
        resetInputLock();
        expect(isInputLocked()).toBe(false);
    });

    // Regression: an earlier version inserted a fullscreen invisible div
    // (#input-lock-overlay) while the lock was held to swallow double-clicks.
    // That overlay also swallowed clicks on the top-bar pause/settings icons,
    // making them unresponsive during a dice roll or token move. Double-click
    // protection is handled by the isInputLocked() gate in handlers — no DOM.
    it('acquireInputLock does not inject a page-level overlay', () => {
        expect(document.getElementById('input-lock-overlay')).toBeNull();
        acquireInputLock();
        expect(document.getElementById('input-lock-overlay')).toBeNull();
        releaseInputLock();
        expect(document.getElementById('input-lock-overlay')).toBeNull();
    });
});

describe('pause / resume flag', () => {
    it('isGameLogicPaused is false by default', () => {
        expect(isGameLogicPaused()).toBe(false);
    });

    it('pauseGameLogic sets the flag, resumeGameLogic clears it', () => {
        pauseGameLogic();
        expect(isGameLogicPaused()).toBe(true);
        resumeGameLogic();
        expect(isGameLogicPaused()).toBe(false);
    });

    it('resumeGameLogic without a pending callback is a no-op', () => {
        pauseGameLogic();
        expect(() => resumeGameLogic()).not.toThrow();
        expect(isGameLogicPaused()).toBe(false);
    });

    // Regression: pausing while a bot-turn callback was queued via
    // scheduleTurn used to drop the callback on the floor — clearTimeout
    // killed the timer without saving the fn into _pendingResume, so the
    // bot stayed frozen until the human clicked dice/pawn to resume.
    it('pausing while a scheduleTurn timer is in flight preserves the callback for resume', async () => {
        vi.useFakeTimers();
        try {
            const fn = vi.fn();
            _scheduleTurnForTest(fn, 600);
            // Pause before the timer fires.
            vi.advanceTimersByTime(100);
            pauseGameLogic();
            // Advance past the original delay — fn must not fire while paused.
            vi.advanceTimersByTime(2000);
            expect(fn).not.toHaveBeenCalled();
            // Resume — pending fn should fire synchronously.
            resumeGameLogic();
            expect(fn).toHaveBeenCalledTimes(1);
        } finally {
            vi.useRealTimers();
        }
    });
});
