import { describe, it, expect, beforeEach, vi } from 'vitest';
// Importing the scripts barrel (transitively pulled in by bot-listener.js)
// runs installBotListener() once at module load, so the listener is already
// subscribed — installing it again here would double every dispatch.
import '../../../scripts/index.js';
import { emit, dispatch, setCommandHandler } from '../../../scripts/game-store.js';
import { EVENTS } from '../../../scripts/game-reducer.js';
import { COMMANDS } from '../../../scripts/command-handler.js';
import { state, PHASES } from '../../../scripts/game-state.js';
import {
    pauseGameLogic,
    resumeGameLogic,
    _resetSchedulerForTest,
} from '../../../scripts/scheduler.js';

// Fake command handler that records dispatched commands and mirrors the real
// handler's *synchronous* phase transition: ROLL_DICE emits DICE_ROLL_STARTED
// (phase → ROLLING) and SELECT_TOKEN emits TOKEN_MOVED (phase → ANIMATING)
// before any async animation. The de-dup guard in resumeAutoplay relies on
// that synchronous transition, so the fake must reproduce it.
let dispatched;
function recordingHandler(_state, command, _services, e) {
    dispatched.push(command);
    if (command.type === COMMANDS.ROLL_DICE) {
        e({ type: EVENTS.DICE_ROLL_STARTED });
    } else if (command.type === COMMANDS.SELECT_TOKEN) {
        e({
            type: EVENTS.TOKEN_MOVED,
            playerIndex: 0,
            tokenIndex: command.tokenIndex,
            fromPosition: -1,
            toPosition: 0,
        });
    }
}

const rolls = () => dispatched.filter(c => c.type === COMMANDS.ROLL_DICE);
const selects = () => dispatched.filter(c => c.type === COMMANDS.SELECT_TOKEN);

beforeEach(() => {
    _resetSchedulerForTest();
    dispatched = [];
    setCommandHandler(recordingHandler);

    // Clean single-bot turn: player 0 is the bot, three human opponents.
    state.playerTypes[0] = 'BOT';
    state.playerTypes[1] = 'HUMAN';
    state.playerTypes[2] = 'HUMAN';
    state.playerTypes[3] = 'HUMAN';
    state.botPersonalities[0] = 'balanced';
    state.currentPlayerIndex = 0;
    state.currentDiceRoll = 6;
    state.consecutiveSixesCount = 0;
    for (let i = 0; i < 4; i++) state.playerTokenPositions[i] = [-1, -1, -1, -1];
    state.movableTokenIndexes = [];
    state.phase = PHASES.AWAITING_ROLL;
    state.assistFlags = {
        autoRollDice: false,
        autoMoveSingleOption: false,
        autoMoveOutOfHome: true,
    };
});

// Regression: dice/token-move animations are NOT pause-aware. Pausing (or
// opening settings) mid-animation lets the animation finish during the pause
// and emit its follow-up event while _paused is true. The bot listener
// early-returns and drops the scheduling, and the scheduler's _pendingResume
// only recovers in-flight scheduleTurn timers — not these dropped events. The
// game was left frozen on resume (only unblockable by clicking the bot's
// dice/pawn, or stuck entirely). resumeAutoplay re-derives the action from the
// restored phase on GAME_RESUMED_FROM_PAUSE.
describe('bot-listener resume recovery', () => {
    it('recovers a bot SELECTION dropped while paused (MOVABLE_TOKENS_DETERMINED during pause)', () => {
        vi.useFakeTimers();
        try {
            // Animation finishes during pause: the follow-up event arrives
            // while the game is paused, so the listener drops it.
            pauseGameLogic();
            emit({ type: EVENTS.MOVABLE_TOKENS_DETERMINED, playerIndex: 0, tokenIndexes: [0] });
            vi.advanceTimersByTime(2000);
            expect(selects()).toHaveLength(0); // dropped — would have frozen the game

            // Resume must re-derive the dropped selection from the phase.
            resumeGameLogic();
            emit({ type: EVENTS.GAME_RESUMED_FROM_PAUSE });
            vi.advanceTimersByTime(2000);
            expect(selects()).toHaveLength(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it('recovers a bot ROLL dropped while paused (TURN_ADVANCED during pause)', () => {
        vi.useFakeTimers();
        try {
            pauseGameLogic();
            emit({ type: EVENTS.TURN_ADVANCED, nextPlayerIndex: 0 }); // bot's turn
            vi.advanceTimersByTime(2000);
            expect(rolls()).toHaveLength(0); // dropped

            resumeGameLogic();
            emit({ type: EVENTS.GAME_RESUMED_FROM_PAUSE });
            vi.advanceTimersByTime(2000);
            expect(rolls()).toHaveLength(1);
        } finally {
            vi.useRealTimers();
        }
    });

    // Regression: resume must not DOUBLE-fire. When an in-flight scheduleTurn
    // timer was stashed in _pendingResume, resumeGameLogic re-fires it AND we
    // also emit GAME_RESUMED_FROM_PAUSE. The pending dispatch synchronously
    // moves phase off AWAITING_* so resumeAutoplay no-ops — exactly one roll.
    it('does not double-roll when a pending timer is re-fired on resume', () => {
        vi.useFakeTimers();
        try {
            // Schedule a bot roll, then pause mid-flight so it lands in
            // _pendingResume.
            emit({ type: EVENTS.TURN_ADVANCED, nextPlayerIndex: 0 });
            vi.advanceTimersByTime(100);
            pauseGameLogic();
            vi.advanceTimersByTime(2000);
            expect(rolls()).toHaveLength(0);

            resumeGameLogic(); // fires _pendingResume → ROLL_DICE → phase ROLLING
            emit({ type: EVENTS.GAME_RESUMED_FROM_PAUSE }); // resumeAutoplay no-ops
            vi.advanceTimersByTime(2000);
            expect(rolls()).toHaveLength(1);
        } finally {
            vi.useRealTimers();
        }
    });

    // An animation still running at resume (phase ROLLING/ANIMATING) will emit
    // its follow-up normally once unpaused, so resume must NOT pre-empt it.
    it('does not schedule anything when an animation is still mid-flight (phase ROLLING)', () => {
        vi.useFakeTimers();
        try {
            state.phase = PHASES.ROLLING;
            resumeGameLogic();
            emit({ type: EVENTS.GAME_RESUMED_FROM_PAUSE });
            vi.advanceTimersByTime(2000);
            expect(rolls()).toHaveLength(0);
            expect(selects()).toHaveLength(0);
        } finally {
            vi.useRealTimers();
        }
    });
});
