import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_LEN } from '../../../tools/extract-whatsnew.mjs';

// The committed Play Store "What's new" source. Both release.yml (production)
// and release-beta.yml (internal) point whatsNewDirectory straight at this
// file's directory, so it is the single source for store release notes. This
// suite runs in the `test` job, which gates BOTH Play upload jobs — so a
// missing, over-cap, or malformed file fails CI before it can reach the store.
//
// Regression guard: the notes used to be a single-line workflow_dispatch input
// whose newlines GitHub silently stripped, shipping every bullet on one line.
// A committed file with real line breaks fixes that structurally; the tests
// below assert the structure stays intact.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const notesPath = resolve(root, 'dev-assets/distribution/store-notes/whatsnew-en-US');
const raw = readFileSync(notesPath, 'utf8');

describe('store-notes whatsnew-en-US', () => {
    it('is non-empty', () => {
        expect(raw.trim().length).toBeGreaterThan(0);
    });

    // Play rejects en-US "What's new" longer than 500 chars, and r0adkll
    // measures the raw file (trailing whitespace counts), so assert on `raw`.
    it('is within the Play Store cap', () => {
        expect(raw.length).toBeLessThanOrEqual(MAX_LEN);
    });

    // Trailing whitespace both wastes the char budget and renders as blank
    // lines on the listing.
    it('has no trailing newline or whitespace', () => {
        expect(raw).toBe(raw.trimEnd());
    });

    it('puts each • bullet on its own line', () => {
        const lines = raw.split('\n');
        // No blank lines between bullets, and every line is a bullet — so two
        // bullets never collapse onto one line (the original newline-strip bug).
        for (const line of lines) {
            expect(line).toMatch(/^• \S/);
        }
        // One "• " per line: bullet count == line count.
        const bulletCount = (raw.match(/•/g) || []).length;
        expect(bulletCount).toBe(lines.length);
    });
});
