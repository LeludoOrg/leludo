import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// Regression: the `9714907` refactor moved audio.js from src/scripts/ into
// src/scripts/render/, one level deeper, but left its asset reference as
// `new URL("../assets/sounds/capture.m4a", import.meta.url)`. That resolved to
// the non-existent src/scripts/assets/, so playCaptureSound() fetched a 404 and
// the capture sound silently stopped working. Guard: every import.meta.url
// asset reference in audio.js must resolve to a file that actually exists, so a
// future move that breaks the relative depth fails CI instead of going silent.
describe('audio.js asset references', () => {
    const audioPath = resolve(process.cwd(), 'src/scripts/render/audio.js');
    const audioDir = dirname(audioPath);
    const src = readFileSync(audioPath, 'utf8');

    const refs = [...src.matchAll(/new URL\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url\s*\)/g)]
        .map(m => m[1]);

    it('references at least one asset', () => {
        expect(refs.length).toBeGreaterThan(0);
    });

    it.each(refs)('asset %s resolves to a file on disk', (rel) => {
        expect(existsSync(resolve(audioDir, rel))).toBe(true);
    });
});
