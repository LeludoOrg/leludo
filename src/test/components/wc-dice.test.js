import { describe, it, expect, vi } from 'vitest'
import '../../components/wc-dice.js'

// Regression: the dice added a document-level space-to-roll "keyup" handler in
// its constructor and never removed it, leaking one handler per re-created
// dice element across games.
const Dice = customElements.get('wc-dice')

describe('wc-dice keyup listener lifecycle', () => {
    it('rolls on space while connected and stops after disconnect', () => {
        const spy = vi.spyOn(Dice.prototype, 'handleDiceClick').mockImplementation(() => {})
        const el = document.createElement('wc-dice')
        document.body.appendChild(el)

        document.dispatchEvent(new KeyboardEvent('keyup', { key: ' ' }))
        expect(spy).toHaveBeenCalledTimes(1)

        el.remove()
        document.dispatchEvent(new KeyboardEvent('keyup', { key: ' ' }))
        expect(spy).toHaveBeenCalledTimes(1) // listener removed on disconnect

        spy.mockRestore()
    })

    it('reconnecting does not duplicate the dice DOM', () => {
        const el = document.createElement('wc-dice')
        document.body.appendChild(el)
        el.remove()
        document.body.appendChild(el)
        expect(el.querySelectorAll('.die').length).toBe(1)
        el.remove()
    })
})
