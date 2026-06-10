/**
 * Forwards game-store events into Google Analytics 4. Mirrors the
 * audio-listener pattern — keeps GA wiring out of the pure game logic.
 *
 * No PII: player names are never sent. We do send player count, bot
 * count + personalities, winner index, ranks, durations.
 */

import { EVENTS, subscribe } from '../game-store.js';
import { trackEvent } from '../analytics.js';

export function installAnalyticsListener() {
    subscribe((event, state) => {
        switch (event.type) {
            case EVENTS.GAME_STARTED: {
                const active = event.playerTypes.filter(Boolean);
                const bots = active.filter(t => t === 'BOT').length;
                trackEvent('game_start', {
                    player_count: active.length,
                    human_count: active.length - bots,
                    bot_count: bots,
                    bot_personalities: (event.botPersonalities || [])
                        .filter(Boolean)
                        .join(','),
                    quick_start_id: event.quickStartId || '',
                });
                break;
            }

            case EVENTS.GAME_ENDED: {
                const durationMs = state.gameStartedAt
                    ? Date.now() - state.gameStartedAt
                    : 0;
                const winnerType = state.playerTypes[state.winnerIndex] || '';
                trackEvent('game_end', {
                    winner_index: state.winnerIndex,
                    winner_type: winnerType,
                    duration_ms: durationMs,
                    duration_s: Math.round(durationMs / 1000),
                    turn_count: state.turnCount,
                    ranks: state.playerRanks.slice(0, 4).join(','),
                });
                break;
            }

            case EVENTS.TOKEN_CAPTURED: {
                trackEvent('capture', {
                    by_player: event.byPlayerIndex,
                    captured_player: event.capturedPlayerIndex,
                    captured_token: event.capturedTokenIndex,
                    turn: state.turnCount,
                });
                break;
            }

            case EVENTS.PLAYER_FINISHED: {
                trackEvent('player_finished', {
                    player_index: event.playerIndex,
                    rank: event.rank,
                    turn: state.turnCount,
                    player_type: state.playerTypes[event.playerIndex] || '',
                });
                break;
            }
        }
    });
}
