import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
    pauseGameLogic,
    resumeGameLogic,
    isGameLogicPaused,
    _scheduleTurnForTest,
} from '../../scripts/state/command-handler.js';
import { reducer, EVENTS } from '../../scripts/state/game-reducer.js';
import { initialGameState, PHASES } from '../../scripts/state/game-state.js';
import * as renderLogic from '../../scripts/render/render-logic.js';

beforeEach(() => {
    if (isGameLogicPaused()) resumeGameLogic();
});

describe('phase machine', () => {
    it('initial phase is AWAITING_ROLL', () => {
        expect(initialGameState().phase).toBe(PHASES.AWAITING_ROLL);
    });

    it('DICE_ROLL_STARTED transitions to ROLLING', () => {
        const s = initialGameState();
        reducer(s, { type: EVENTS.DICE_ROLL_STARTED });
        expect(s.phase).toBe(PHASES.ROLLING);
    });

    it('MOVABLE_TOKENS_DETERMINED transitions to AWAITING_SELECTION + records movable list', () => {
        const s = initialGameState();
        reducer(s, { type: EVENTS.MOVABLE_TOKENS_DETERMINED, playerIndex: 0, tokenIndexes: [1, 3] });
        expect(s.phase).toBe(PHASES.AWAITING_SELECTION);
        expect(s.movableTokenIndexes).toEqual([1, 3]);
    });

    it('TOKEN_MOVED transitions to ANIMATING', () => {
        const s = initialGameState();
        s.playerTokenPositions[0] = [-1, -1, -1, -1];
        reducer(s, {
            type: EVENTS.TOKEN_MOVED,
            playerIndex: 0,
            tokenIndex: 0,
            fromPosition: -1,
            toPosition: 0,
        });
        expect(s.phase).toBe(PHASES.ANIMATING);
    });

    it('TURN_ADVANCED returns to AWAITING_ROLL and clears movable list', () => {
        const s = initialGameState();
        s.movableTokenIndexes = [0, 2];
        s.phase = PHASES.ANIMATING;
        reducer(s, { type: EVENTS.TURN_ADVANCED, nextPlayerIndex: 1 });
        expect(s.phase).toBe(PHASES.AWAITING_ROLL);
        expect(s.movableTokenIndexes).toEqual([]);
    });

    it('TURN_REPEATS returns to AWAITING_ROLL', () => {
        const s = initialGameState();
        s.phase = PHASES.ANIMATING;
        reducer(s, { type: EVENTS.TURN_REPEATS });
        expect(s.phase).toBe(PHASES.AWAITING_ROLL);
    });

    it('GAME_ENDED transitions to GAME_ENDED', () => {
        const s = initialGameState();
        reducer(s, { type: EVENTS.GAME_ENDED, winnerIndex: 2 });
        expect(s.phase).toBe(PHASES.GAME_ENDED);
    });

    // Regression: pause/resume MUST NOT mutate phase. The old code swapped
    // phase to 'PAUSED' and restored a snapshot on resume, which clobbered
    // legitimate phase advances made by in-flight animations that complete
    // DURING the pause — rewinding phase to ROLLING/ANIMATING left the bot
    // frozen (game stuck) on resume. Pause is enforced by the scheduler's
    // _paused flag, not by phase.
    it('GAME_PAUSED / GAME_RESUMED_FROM_PAUSE leave phase untouched', () => {
        const s = initialGameState();
        s.phase = PHASES.AWAITING_SELECTION;
        reducer(s, { type: EVENTS.GAME_PAUSED });
        expect(s.phase).toBe(PHASES.AWAITING_SELECTION);
        reducer(s, { type: EVENTS.GAME_RESUMED_FROM_PAUSE });
        expect(s.phase).toBe(PHASES.AWAITING_SELECTION);
    });

    // The dangerous case the old phase-restore broke: an animation finishes
    // while paused and advances phase (here AWAITING_ROLL -> AWAITING_SELECTION
    // via MOVABLE_TOKENS_DETERMINED). Resume must keep the advanced phase so
    // the bot listener can act on it — not rewind to the pre-pause snapshot.
    it('phase advanced during pause survives resume', () => {
        const s = initialGameState();
        s.phase = PHASES.ROLLING;
        reducer(s, { type: EVENTS.GAME_PAUSED });
        reducer(s, { type: EVENTS.MOVABLE_TOKENS_DETERMINED, playerIndex: 0, tokenIndexes: [1] });
        expect(s.phase).toBe(PHASES.AWAITING_SELECTION);
        reducer(s, { type: EVENTS.GAME_RESUMED_FROM_PAUSE });
        expect(s.phase).toBe(PHASES.AWAITING_SELECTION);
    });
});

describe('pause / resume scheduler', () => {
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
            vi.advanceTimersByTime(100);
            pauseGameLogic();
            vi.advanceTimersByTime(2000);
            expect(fn).not.toHaveBeenCalled();
            resumeGameLogic();
            expect(fn).toHaveBeenCalledTimes(1);
        } finally {
            vi.useRealTimers();
        }
    });

    // Regression: an earlier version inserted a fullscreen invisible div
    // (#input-lock-overlay) to swallow double-clicks. That overlay also
    // swallowed clicks on the top-bar pause/settings icons. The phase
    // machine handles double-click protection without any DOM overlay.
    it('the phase machine alone gates input — no page-level overlay exists', () => {
        expect(document.getElementById('input-lock-overlay')).toBeNull();
    });
});

describe('turn counter consistency', () => {
    // Regression: advanceToNextPlayer called updateTurnCounter() unconditionally,
    // even when getNextPlayerIndex returned -1 (no more active players). This caused
    // the render-logic's module-local turnCount to outrun state.turnCount. The
    // persistence-listener then saved the drifted render copy, making a loaded save
    // have a stale count. After the fix, renderTurnCount is a pure paint function
    // and state.turnCount is the only source of truth.
    it('state.turnCount is the single source of truth — render counter deleted', () => {
        // The old code exported four separate counter-mutation functions:
        // updateTurnCounter, resetTurnCount, getTurnCount, setTurnCount.
        // After the fix, only renderTurnCount (pure paint) remains in the exports.
        // Verify getTurnCount is no longer exported.
        expect(renderLogic.getTurnCount).toBeUndefined();
        expect(renderLogic.updateTurnCounter).toBeUndefined();
        expect(renderLogic.resetTurnCount).toBeUndefined();
        // setTurnCount is deleted; its name is reused for renderTurnCount.
        expect(renderLogic.setTurnCount).toBeUndefined();
        // renderTurnCount is the new pure paint function.
        expect(typeof renderLogic.renderTurnCount).toBe('function');
    });

    it('the persisted save always carries state.turnCount (no drifted display copy)', async () => {
        // Drive the REAL store + persistence listener: the save written to
        // localStorage must equal the reducer's turnCount, because the old code
        // saved render-logic's display counter, which advanceToNextPlayer bumped
        // even on turns where no TURN_ADVANCED was emitted.
        const { emit } = await import('../../scripts/state/game-store.js');
        const { state } = await import('../../scripts/state/game-state.js');
        const { installPersistenceListener } = await import('../../scripts/listeners/persistence-listener.js');
        const { STORAGE_KEYS } = await import('../../scripts/platform/storage-keys.js');

        installPersistenceListener();
        emit({
            type: EVENTS.GAME_STARTED,
            quickStartId: 'qs,1,1,0,1',
            gameStartedAt: 1,
            playerTypes: ['PLAYER', 'BOT', undefined, undefined],
            botPersonalities: [null, 'balanced', null, null],
            playerNames: ['Ana', 'Bo', '', ''],
            playerTokenPositions: [[-1, -1, -1, -1], [-1, -1, -1, -1], undefined, undefined],
            currentPlayerIndex: 0,
        });
        emit({ type: EVENTS.TURN_ADVANCED, nextPlayerIndex: 1 });
        emit({ type: EVENTS.TURN_ADVANCED, nextPlayerIndex: 0 });

        const saved = JSON.parse(localStorage.getItem(STORAGE_KEYS.SAVE));
        expect(state.turnCount).toBe(2);
        expect(saved.turnCount).toBe(state.turnCount);
        localStorage.removeItem(STORAGE_KEYS.SAVE);
    });
});
