import { describe, it, expect, vi } from 'vitest'
import '../../components/wc-quick-start.js'
import { MSG } from '../../scripts/net/net-protocol.js'

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
