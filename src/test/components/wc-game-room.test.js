import { describe, it, expect } from 'vitest'
import '../../components/wc-game-room.js'

// The online room mounts in a "connecting" state before the first lobby STATE
// arrives: the banner reads "Joining room", the share invite hides (nothing to
// share yet), and the seat-list shows shimmering skeleton rows instead of a
// bare "Connecting…" line. The first renderLobby (or onBusy) ends that state.
const mount = () => {
    const el = document.createElement('wc-game-room')
    document.body.appendChild(el)
    return el
}

const lobbyState = {
    hostSeat: 0,
    started: false,
    seats: [
        { index: 0, type: 'PLAYER', claimed: true, connected: true, name: 'You', isHost: true },
        { index: 1, type: 'PLAYER', claimed: false, connected: false },
        { index: 2, type: 'BOT', name: 'Bot 3' },
        { index: 3, type: null },
    ],
}

describe('wc-game-room connecting state', () => {
    it('mounts into a skeleton "Joining room" connecting state', () => {
        const el = mount()
        expect(el.classList.contains('is-connecting')).toBe(true)
        expect(el.querySelector('[data-testid="online-room-eyebrow"]').textContent).toBe('Joining room')
        // Four shimmering seat placeholders, mirroring the four chairs a room holds.
        expect(el.querySelectorAll('.seat-skeleton').length).toBe(4)
        // No status-line text — the connecting line lives in the banner.
        expect(el.querySelector('[data-testid="online-status"]').textContent).toBe('')
        el.remove()
    })

    it('renderLobby ends the connecting state and replaces skeletons with real seats', () => {
        const el = mount()
        el.renderLobby(lobbyState, 0)
        expect(el.classList.contains('is-connecting')).toBe(false)
        expect(el.querySelector('[data-testid="online-room-eyebrow"]').textContent).toBe('Room code')
        expect(el.querySelectorAll('.seat-skeleton').length).toBe(0)
        // Four real seat rows now render (3 filled/open + 1 empty chair).
        expect(el.querySelectorAll('.seat-row, .seat-row-empty').length).toBe(4)
        el.remove()
    })

    it('onBusy ends the connecting state and clears the skeletons', () => {
        const el = mount()
        el.onBusy()
        expect(el.classList.contains('is-connecting')).toBe(false)
        expect(el.querySelectorAll('.seat-skeleton').length).toBe(0)
        expect(el.querySelector('[data-testid="online-status"]').textContent).toMatch(/busy/i)
        el.remove()
    })
})
