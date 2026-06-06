import { describe, it, expect, beforeEach } from 'vitest';
import { buildSeatLayout } from '../../scripts/online-game.js';
import { clearOnline } from '../../scripts/online-state.js';

/**
 * buildSeatLayout maps a server snapshot onto this client's board positions.
 * These guard the two bugs the live 2-player game surfaced: the opponent must
 * sit diagonally for BOTH players, and the colour map must stay a permutation
 * so an empty quad never repeats an active player's colour (the "two greens,
 * no yellow" board).
 */
describe('buildSeatLayout (online seat → board layout)', () => {
    beforeEach(() => clearOnline());

    // A 2-player public match on adjacent server seats 0 (red) and 1 (green).
    const twoPlayerState = {
        playerTypes: ['PLAYER', 'PLAYER', null, null],
        playerNames: ['Divya', 'Giddu', '', ''],
        positions: [[-1, -1, -1, -1], [-1, -1, -1, -1], null, null],
        currentPlayerIndex: 0,
    };

    it('keeps the colour map a permutation (no repeated colour, yellow present)', () => {
        // Before the fix this returned [1,1,0,3] for the non-host: two greens
        // (1) and no yellow (2). The empty quads must take the leftover colours.
        const host = buildSeatLayout({}, 0, twoPlayerState);
        expect([...host.colorMap].sort()).toEqual([0, 1, 2, 3]);

        const guest = buildSeatLayout({}, 1, twoPlayerState);
        expect([...guest.colorMap].sort()).toEqual([0, 1, 2, 3]);
        expect(guest.colorMap).toContain(2); // yellow is on the board
    });

    it('seats this client bottom-right in its own colour, opponent top-left', () => {
        // Guest = server seat 1 (green). Self at board pos 2 (bottom-right) shows
        // seat 1's colour; the opponent (seat 0) sits diagonally at pos 0.
        const guest = buildSeatLayout({}, 1, twoPlayerState);
        expect(guest.playerTypes[2]).toBe('PLAYER'); // self bottom-right
        expect(guest.colorMap[2]).toBe(1);           // in seat 1's colour (green)
        expect(guest.playerTypes[0]).toBe('PLAYER'); // opponent top-left
        expect(guest.colorMap[0]).toBe(0);           // seat 0's colour (red)
        expect(guest.playerNames[2]).toBe('Giddu');
        expect(guest.playerNames[0]).toBe('Divya');
    });

    it('colours the two empty quads consistently across both 2P screens', () => {
        // Regression (the two-screenshot report): the empty quads must be the same
        // board rotated, so a pawn sits next to the SAME colours on both screens.
        // The guest's whole colour map must be the host's rotated 180° (the two
        // players are diagonal), empty quads included — not the leftover colours
        // dropped into board order, which swapped red/yellow between the screens.
        const host = buildSeatLayout({}, 0, twoPlayerState).colorMap;
        const guest = buildSeatLayout({}, 1, twoPlayerState).colorMap;
        const rotated180 = [host[2], host[3], host[0], host[1]];
        expect(guest).toEqual(rotated180);
    });

    it('4-player game keeps every seat in its own colour (identity map)', () => {
        const state = {
            playerTypes: ['PLAYER', 'PLAYER', 'PLAYER', 'PLAYER'],
            playerNames: ['A', 'B', 'C', 'D'],
            positions: [[-1, -1, -1, -1], [-1, -1, -1, -1], [-1, -1, -1, -1], [-1, -1, -1, -1]],
            currentPlayerIndex: 0,
        };
        const view = buildSeatLayout({}, 2, state);
        expect([...view.colorMap].sort()).toEqual([0, 1, 2, 3]);
        // Self is server seat 2 → board pos 2 in seat 2's colour.
        expect(view.colorMap[2]).toBe(2);
    });
});
