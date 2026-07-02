import { describe, it, expect, vi } from 'vitest'
import { buildQuickStart } from '../../components/wc-quick-start.js'
import { MSG } from '../../scripts/net/net-protocol.js'
import { getPlayerTypes } from '../../scripts/core/game-logic.js'

// Regression: a reconnect that lands the client OUT of its game must leave the
// dead board, not freeze on it. The server-side fix (persist/restore) resumes
// most deploys, but when the game is genuinely unrecoverable the client redials
// into a FRESH lobby — a STATE with started:false. The host hit this hardest:
// the online driver drops un-started snapshots, so the host sat frozen on a
// stale board while the opponent showed as still-connected. _onNetMessage now
// treats an in-game started:false snapshot like a forfeit and exits.
const QS = customElements.get('wc-quick-start')

const makeInGame = () => {
    const el = document.createElement('wc-quick-start')
    el._inGame = true
    el._net = {} // _onNetMessage gates on this._net === client
    return el
}

describe('wc-quick-start reconnect-into-dead-game handling', () => {
    it('exits when an in-game reconnect lands in a fresh lobby (started:false)', () => {
        const el = makeInGame()
        const exit = vi.spyOn(el, '_exitDeadGame').mockImplementation(() => {})
        el._onNetMessage({ t: MSG.STATE, state: { started: false } }, el._net)
        expect(exit).toHaveBeenCalledTimes(1)
        expect(el._inGame).toBe(true) // unchanged here only because _exitDeadGame is stubbed
    })

    it('still exits on the existing forfeit path (ERROR)', () => {
        const el = makeInGame()
        const exit = vi.spyOn(el, '_exitDeadGame').mockImplementation(() => {})
        el._onNetMessage({ t: MSG.ERROR, error: 'ROOM_FULL' }, el._net)
        expect(exit).toHaveBeenCalledTimes(1)
    })

    it('does NOT exit for a normal in-game snapshot (started:true)', () => {
        const el = makeInGame()
        const exit = vi.spyOn(el, '_exitDeadGame').mockImplementation(() => {})
        // started:true → drives the board via the online driver (a no-op here,
        // since no online game is mounted), and must never trip the exit path.
        el._onNetMessage({ t: MSG.STATE, state: { started: true } }, el._net)
        expect(exit).not.toHaveBeenCalled()
    })
})

describe('buildQuickStart — START_GAME payload from the seat list', () => {
    // Regression: _startGame used to re-implement the seat-placement algorithm
    // (HUMAN_PREFERRED_POSITIONS walk + bot fill) independently of
    // getPlayerTypes, so a drift put names on the wrong seats. It now derives
    // names from getPlayerTypes' own output via buildQuickStart — these cases
    // pin the name↔position alignment through the REAL helper.

    it('mixed lineup: human at preferred position 2, bots fill 0/1, empty seat blank', () => {
        const seats = [
            { active: true, type: 'PLAYER', colorIndex: 0, name: 'Ana' },
            { active: true, type: 'BOT', colorIndex: 1, name: 'Bo' },
            { active: true, type: 'BOT', colorIndex: 2, name: 'Cy' },
            { active: false, type: 'BOT', colorIndex: null, name: '' },
        ]
        const { quickStartId, namesByPlayerIndex } = buildQuickStart(seats)
        expect(quickStartId).toBe('qs,1,2,0,1,2')
        // Names must land exactly where getPlayerTypes seats those colours.
        expect(namesByPlayerIndex).toEqual(['Bo', 'Cy', 'Ana', ''])
        const { playerTypes } = getPlayerTypes(quickStartId)
        expect(playerTypes).toEqual(['BOT', 'BOT', 'PLAYER', undefined])
    })

    it('all-humans lineup: names at board positions 0-3 in seat order', () => {
        const seats = [
            { active: true, type: 'PLAYER', colorIndex: 0, name: 'Ana' },
            { active: true, type: 'PLAYER', colorIndex: 1, name: 'Bo' },
            { active: true, type: 'PLAYER', colorIndex: 2, name: 'Cy' },
            { active: true, type: 'PLAYER', colorIndex: 3, name: 'Dana' },
        ]
        const { quickStartId, namesByPlayerIndex } = buildQuickStart(seats)
        expect(quickStartId).toBe('qs,4,0,0,1,2,3')
        expect(namesByPlayerIndex).toEqual(['Ana', 'Bo', 'Cy', 'Dana'])
    })

    it('two humans sit diagonally opposite (positions 2 and 0)', () => {
        const seats = [
            { active: true, type: 'PLAYER', colorIndex: 0, name: 'Ana' },
            { active: true, type: 'PLAYER', colorIndex: 1, name: 'Bo' },
            { active: true, type: 'BOT', colorIndex: 2, name: 'Cy' },
            { active: true, type: 'BOT', colorIndex: 3, name: 'Dee' },
        ]
        const { namesByPlayerIndex } = buildQuickStart(seats)
        // HUMAN_PREFERRED_POSITIONS = [2, 0, ...]: Ana at 2, Bo at 0; bots
        // fill the remaining positions 1 and 3 in seat order.
        expect(namesByPlayerIndex).toEqual(['Bo', 'Cy', 'Ana', 'Dee'])
    })
})
