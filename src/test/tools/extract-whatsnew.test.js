import { describe, it, expect } from 'vitest';
import {
    MAX_LEN,
    stripTags,
    decodeEntities,
    extractBullets,
    buildWhatsnewText,
} from '../../../tools/extract-whatsnew.mjs';

function makeChangelog(version, ...bulletsHtml) {
    return `
<html><body>
<article>
  <div class="cl-entry-version">v${version}</div>
  <div class="section-label">Highlights</div>
  <ul>
    ${bulletsHtml.map((b) => `<li>${b}</li>`).join('\n')}
  </ul>
</article>
</body></html>`;
}

describe('stripTags', () => {
    it('removes inline tags but keeps text', () => {
        expect(stripTags('A <strong>bold</strong> thing <em>here</em>'))
            .toBe('A bold thing here');
    });
});

describe('decodeEntities', () => {
    it('decodes common HTML entities the changelog uses', () => {
        expect(decodeEntities('&rsquo;s &ldquo;ok&rdquo; &mdash; fine'))
            .toBe('’s “ok” — fine');
    });
    // The changelog wraps long lines, so consecutive whitespace gets
    // collapsed to a single space. Keeps the output compact for the
    // Play Store's tight char budget.
    it('collapses whitespace', () => {
        expect(decodeEntities('line one\n      line two')).toBe('line one line two');
    });
});

describe('extractBullets', () => {
    it('pulls bullets from the matching version article', () => {
        const html = makeChangelog('0.42.0', 'First bullet', 'Second bullet');
        expect(extractBullets(html, '0.42.0')).toEqual(['First bullet', 'Second bullet']);
    });
    it('throws when no article matches the version', () => {
        const html = makeChangelog('0.42.0', 'bullet');
        expect(() => extractBullets(html, '0.99.0')).toThrow(/No changelog article found/);
    });
    it('throws when the article has no Highlights ul', () => {
        const html = `<article><div class="cl-entry-version">v0.42.0</div></article>`;
        expect(() => extractBullets(html, '0.42.0')).toThrow(/No Highlights/);
    });
});

describe('buildWhatsnewText', () => {
    it('prefixes each bullet with • and joins with newlines', () => {
        expect(buildWhatsnewText(['First', 'Second'])).toBe('• First\n• Second');
    });
    it('keeps short text under the cap unchanged', () => {
        const out = buildWhatsnewText(['Short note']);
        expect(out).toBe('• Short note');
        expect(out.length).toBeLessThanOrEqual(MAX_LEN);
    });
    // Mid-sentence ellipsis truncation produces ugly Play Store release
    // notes ("…and clear it with the × — the same controls you already
    // kno…"). Better to fail the release pipeline loudly so the author
    // shortens the changelog entry. The error message names the actual
    // length and the overflow so the dev knows how many chars to trim.
    it('throws with length + overflow detail when bullets exceed the cap', () => {
        const longBullet = 'x'.repeat(600);
        expect(() => buildWhatsnewText([longBullet])).toThrow(/602 chars/);
        expect(() => buildWhatsnewText([longBullet])).toThrow(/over by 102/);
        expect(() => buildWhatsnewText([longBullet])).toThrow(/Shorten the changelog/);
    });
    // Boundary: exactly MAX_LEN chars passes — Play Store accepts up to
    // and including the cap.
    it('accepts text at exactly MAX_LEN', () => {
        // "• " prefix is 2 chars, so 498 x's leaves exactly 500 chars.
        const bullet = 'x'.repeat(498);
        const out = buildWhatsnewText([bullet]);
        expect(out.length).toBe(MAX_LEN);
    });
    it('throws when over by even 1 char', () => {
        // 499 x's gives "• " + 499 = 501 chars, one over the cap.
        const bullet = 'x'.repeat(499);
        expect(() => buildWhatsnewText([bullet])).toThrow(/over by 1/);
    });
    it('respects a custom cap', () => {
        expect(() => buildWhatsnewText(['anything'], 5)).toThrow(/10 chars \(max 5/);
    });
    it('produces no trailing whitespace for typical multi-bullet input', () => {
        const out = buildWhatsnewText(['First', 'Second', 'Third']);
        expect(out).toBe(out.trimEnd());
    });
});
