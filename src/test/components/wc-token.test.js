import { describe, it, expect, vi } from 'vitest'
import '../../components/wc-token.js'

// Regression: the token used to add a document-level "keyup" handler on every
// id assignment and never remove it, so re-created tokens (16 per game) piled
// up handlers and double-dispatched SELECT_TOKEN. It also appended a second
// pawn SVG when the id was re-assigned (the old `// fixme`).
const Token = customElements.get('wc-token')

describe('wc-token keyup listener lifecycle', () => {
    it('handles its number key while connected and stops after disconnect', () => {
        const spy = vi.spyOn(Token.prototype, 'handleTokenClick').mockImplementation(() => {})
        const el = document.createElement('wc-token')
        el.id = 'token-0-0'           // tokenIndex 0 → reacts to key "1"
        document.body.appendChild(el)

        document.dispatchEvent(new KeyboardEvent('keyup', { key: '1' }))
        expect(spy).toHaveBeenCalledTimes(1)

        el.remove()                   // disconnectedCallback aborts the listener
        document.dispatchEvent(new KeyboardEvent('keyup', { key: '1' }))
        expect(spy).toHaveBeenCalledTimes(1) // no further dispatch after disconnect

        spy.mockRestore()
    })

    it('re-assigning the id re-renders in place instead of stacking SVGs', () => {
        const el = document.createElement('wc-token')
        el.id = 'token-1-0'
        document.body.appendChild(el)
        el.id = 'token-1-1'
        el.id = 'token-2-2'
        expect(el.querySelectorAll('svg').length).toBe(1)
        el.remove()
    })
})
