import { describe, it, expect } from 'vitest';
import {
    MAX_LEN,
    stripTags,
    decodeEntities,
    extractBullets,
    buildWhatsnewText,
} from '../../tools/extract-whatsnew.mjs';

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
    // Regression: an earlier version sliced to MAX_LEN-1 + '…' = MAX_LEN
    // and then writeFile added a trailing newline, pushing the file to
    // MAX_LEN + 1 chars. Play Store rejected the upload with "length
    // 501, which is too long (max: 500)." buildWhatsnewText now produces
    // a string with no trailing newline so the file written is exactly
    // text.length and never exceeds MAX_LEN.
    it('truncates over-budget bullets to exactly MAX_LEN with an ellipsis (no trailing newline)', () => {
        const longBullet = 'x'.repeat(600);
        const out = buildWhatsnewText([longBullet]);
        expect(out.length).toBe(MAX_LEN);
        expect(out.endsWith('…')).toBe(true);
        expect(out.endsWith('\n')).toBe(false);
    });
    // Defense-in-depth: ellipsis math itself stays inside the cap. If
    // someone breaks the slice budget later, the explicit length check
    // throws rather than silently shipping an oversized file.
    it('throws if a custom cap somehow leaves text over budget', () => {
        // The internal slice is `max - 1`, so a max of 0 + 1 char append
        // would have to overflow. Use slice() semantics — at max=0,
        // text.slice(0, -1) is '', plus '…' is 1 char > 0. Throws.
        expect(() => buildWhatsnewText(['anything'], 0)).toThrow(/after truncation/);
    });
    it('produces no trailing whitespace for typical multi-bullet input', () => {
        const out = buildWhatsnewText(['First', 'Second', 'Third']);
        expect(out).toBe(out.trimEnd());
    });
});
