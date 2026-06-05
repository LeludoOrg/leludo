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
import { setOnline, clearOnline, onlineLocalSelf } from '../../../scripts/online-state.js';

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
    clearOnline(); // default every test to local mode; online tests opt in
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

// Regression: in online mode the assist toggles (auto-roll / auto-move) did
// nothing — maybeAutoRoll/maybeAutoSelect blanket-returned on isOnlineActive(),
// so a player with "Auto-roll dice" on still had to tap the dice every turn.
// Online the server drives bots and remote players, but the LOCAL player's own
// assists must still fire: dispatching ROLL_DICE / SELECT_TOKEN becomes a server
// intent (gated to self by the command-handler), exactly like a manual tap.
describe('bot-listener online assists (own turn only)', () => {
    const SELF = onlineLocalSelf(); // this client's board position (bottom-right)

    beforeEach(() => {
        setOnline({}, 2, [0, 1, 2, 3]); // server seat 2, four-player game
        // Online there are no local bots to drive; every seat is server-authored.
        for (let i = 0; i < 4; i++) state.playerTypes[i] = 'HUMAN';
        state.playerTokenPositions[SELF] = [-1, -1, -1, -1];
    });

    it('auto-rolls on our OWN turn when the flag is on', () => {
        vi.useFakeTimers();
        try {
            state.assistFlags.autoRollDice = true;
            state.currentPlayerIndex = SELF;
            state.phase = PHASES.AWAITING_ROLL;
            emit({ type: EVENTS.TURN_ADVANCED, nextPlayerIndex: SELF });
            vi.advanceTimersByTime(2000);
            expect(rolls()).toHaveLength(1); // sent a roll intent for us
        } finally {
            vi.useRealTimers();
        }
    });

    it('does NOT auto-roll on another seat\'s turn (server drives them)', () => {
        vi.useFakeTimers();
        try {
            state.assistFlags.autoRollDice = true;
            state.currentPlayerIndex = 0; // a remote/bot seat, not us
            state.phase = PHASES.AWAITING_ROLL;
            emit({ type: EVENTS.TURN_ADVANCED, nextPlayerIndex: 0 });
            vi.advanceTimersByTime(2000);
            expect(rolls()).toHaveLength(0);
        } finally {
            vi.useRealTimers();
        }
    });

    it('does NOT auto-roll on our turn when the flag is off', () => {
        vi.useFakeTimers();
        try {
            state.assistFlags.autoRollDice = false;
            state.currentPlayerIndex = SELF;
            state.phase = PHASES.AWAITING_ROLL;
            emit({ type: EVENTS.TURN_ADVANCED, nextPlayerIndex: SELF });
            vi.advanceTimersByTime(2000);
            expect(rolls()).toHaveLength(0);
        } finally {
            vi.useRealTimers();
        }
    });

    it('auto-moves out of home on our OWN turn (all home + a six)', () => {
        vi.useFakeTimers();
        try {
            state.assistFlags.autoMoveOutOfHome = true;
            state.assistFlags.autoMoveSingleOption = false;
            state.currentPlayerIndex = SELF;
            state.currentDiceRoll = 6;
            state.playerTokenPositions[SELF] = [-1, -1, -1, -1];
            emit({ type: EVENTS.MOVABLE_TOKENS_DETERMINED, playerIndex: SELF, tokenIndexes: [0, 1, 2, 3] });
            vi.advanceTimersByTime(2000);
            expect(selects()).toHaveLength(1); // sent a move intent for us
        } finally {
            vi.useRealTimers();
        }
    });

    it('does NOT auto-move on another seat\'s turn', () => {
        vi.useFakeTimers();
        try {
            state.assistFlags.autoMoveOutOfHome = true;
            state.currentPlayerIndex = 0; // not us
            state.currentDiceRoll = 6;
            state.playerTokenPositions[0] = [-1, -1, -1, -1];
            emit({ type: EVENTS.MOVABLE_TOKENS_DETERMINED, playerIndex: 0, tokenIndexes: [0, 1, 2, 3] });
            vi.advanceTimersByTime(2000);
            expect(selects()).toHaveLength(0);
        } finally {
            vi.useRealTimers();
        }
    });
});
