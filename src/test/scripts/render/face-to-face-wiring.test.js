import { describe, it, expect, beforeEach } from 'vitest';
import {
    updateCornerWidgets,
    refreshBoardOrientation,
    initRailDeps,
    setPlayerNames,
} from '../../../scripts/render/render-logic.js';
import { getBoardQuarterTurns } from '../../../scripts/render/board-orientation.js';
import { STORAGE_KEYS } from '../../../scripts/platform/storage-keys.js';

// Wiring guard: a turn handoff (moveDice → updateCornerWidgets) must spin the
// .board-rotor to face the active player ONLY in the offline pass-and-play case
// the feedback asked about — exactly two humans on opposite halves, toggle on.
// Every other configuration (solo vs bots, same-half pair, toggle off) must
// leave the board un-rotated so single-player / online boards are untouched.

let currentPi = 0;

function setupDom() {
    document.body.innerHTML = '';
    const rotor = document.createElement('div');
    rotor.className = 'board-rotor';
    document.body.appendChild(rotor);
    ['b0', 'b1', 'b2', 'b3'].forEach((id) => {
        const el = document.createElement('div');
        el.id = id;
        document.body.appendChild(el);
    });
    return rotor;
}

function rotorDeg() {
    return document.querySelector('.board-rotor').style.getPropertyValue('--board-rot');
}

describe('face-to-face rotation wiring (updateCornerWidgets)', () => {
    let rotor;
    beforeEach(() => {
        localStorage.clear();
        rotor = setupDom();
        currentPi = 0;
        // Diagonal humans on opposite halves: seat 0 (top-left) + seat 2
        // (bottom-right), bots in the other two seats.
        initRailDeps(['PLAYER', 'BOT', 'PLAYER', 'BOT'], () => currentPi, () => 0);
        setPlayerNames(['A', 'Bot', 'B', 'Bot']);
    });

    it('flips 180° for a top-half player, 0° for the bottom-half player', () => {
        currentPi = 0; // top-left home → rotate to face the far player
        updateCornerWidgets();
        expect(rotorDeg()).toBe('180deg');
        expect(getBoardQuarterTurns()).toBe(2);

        currentPi = 2; // bottom-right home → already faces the near player
        updateCornerWidgets();
        expect(rotorDeg()).toBe('0deg');
        expect(getBoardQuarterTurns()).toBe(0);
    });

    it('stays put when the toggle is off', () => {
        localStorage.setItem(STORAGE_KEYS.ROTATE_TO_PLAYER, 'false');
        currentPi = 0;
        updateCornerWidgets();
        expect(rotorDeg()).toBe('0deg');
        expect(getBoardQuarterTurns()).toBe(0);
    });

    it('refreshBoardOrientation re-applies for the current player out of band', () => {
        currentPi = 0;
        refreshBoardOrientation();
        expect(rotorDeg()).toBe('180deg');
    });

    it('does not rotate a solo game (one human vs bots)', () => {
        initRailDeps(['PLAYER', 'BOT', 'BOT', 'BOT'], () => currentPi, () => 0);
        currentPi = 0;
        updateCornerWidgets();
        expect(getBoardQuarterTurns()).toBe(0);
    });

    it('does not rotate two humans seated on the SAME half (no facing benefit)', () => {
        // Seats 0 + 1 are both top corners — a 180° flip never faces either, so
        // the feature stays inert rather than flipping pointlessly every turn.
        initRailDeps(['PLAYER', 'PLAYER', 'BOT', 'BOT'], () => currentPi, () => 0);
        currentPi = 1;
        updateCornerWidgets();
        expect(getBoardQuarterTurns()).toBe(0);
    });
});
