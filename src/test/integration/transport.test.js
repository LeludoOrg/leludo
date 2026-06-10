import { describe, it, expect } from 'vitest';
import { runGame, makeRng } from '../../scripts/core/game-driver.js';
import { createMockNetworkPair } from '../../scripts/net/transport/mock-network-channel.js';
import { reducer, applyEvents } from '../../scripts/state/game-reducer.js';
import { initialGameState } from '../../scripts/state/game-state.js';

/**
 * Phase F serialization proof: every event the game produces survives a
 * JSON.parse(JSON.stringify(...)) round-trip and rebuilds identical
 * state. This is the contract a real WebSocket transport will rely on
 * when shipping events across the wire.
 */

describe('mock-network channel: serializability', () => {
    const seeds = [1, 2, 3, 7, 42];
    const BOT4 = ['BOT', 'BOT', 'BOT', 'BOT'];

    it.each(seeds)('seed %i: events survive JSON round-trip and reconstruct state', (seed) => {
        const result = runGame({ playerTypes: BOT4, rng: makeRng(seed), maxTurns: 20000 });

        const clientState = initialGameState();
        const { client, server } = createMockNetworkPair({
            applyCommand(_cmd, srv) {
                // Replay role: the server simply re-broadcasts events from
                // the recorded log. Real server would compute these.
                for (const e of result.events) srv.broadcast(e);
            },
        });

        client.onEvents((events) => {
            for (const e of events) reducer(clientState, e);
        });

        client.send({ type: 'REPLAY_RECORDED_GAME' });

        expect(clientState.playerTokenPositions).toEqual(result.positions);
        expect(clientState.playerRanks).toEqual(result.ranks);
        expect(clientState.playerCaptures).toEqual(result.captures);
        expect(clientState.lastRank).toBe(result.lastRank);
        expect(clientState.winnerIndex).toBe(result.winner);
    });

    it('non-serializable payloads break the round-trip cleanly', () => {
        const { client } = createMockNetworkPair({
            applyCommand(cmd) {
                // The JSON round-trip strips the function field. After encoding
                // it's gone; nothing else throws.
                expect(cmd.handler).toBeUndefined();
                return cmd;
            },
        });
        client.send({ type: 'COMMAND_WITH_FUNCTION', handler: () => 'oops' });
    });
});

describe('mock-network channel: command + event hop', () => {
    it('client.send routes commands to applyCommand verbatim (after JSON encode)', () => {
        let received = null;
        const { client } = createMockNetworkPair({
            applyCommand(cmd) { received = cmd; },
        });
        client.send({ type: 'TEST_COMMAND', payload: { nested: { value: 42 } } });
        expect(received).toEqual({ type: 'TEST_COMMAND', payload: { nested: { value: 42 } } });
    });

    it('server.broadcast routes events to all subscribed client handlers', () => {
        const calls = [];
        const { client, server } = createMockNetworkPair({ applyCommand() {} });
        client.onEvents((events) => calls.push(['A', events]));
        client.onEvents((events) => calls.push(['B', events]));
        server.broadcast({ type: 'TEST_EVENT', value: 1 });
        expect(calls).toEqual([
            ['A', [{ type: 'TEST_EVENT', value: 1 }]],
            ['B', [{ type: 'TEST_EVENT', value: 1 }]],
        ]);
    });

    it('applyEvents folds a recorded event list into a fresh state', () => {
        const result = runGame({
            playerTypes: ['BOT', 'BOT', 'BOT', 'BOT'],
            rng: makeRng(99),
            maxTurns: 20000,
        });
        const folded = applyEvents(result.events);
        expect(folded.playerRanks).toEqual(result.ranks);
        expect(folded.lastRank).toBe(result.lastRank);
    });
});
