#!/usr/bin/env node
// Capture screenshots for marketing/store at Pixel 9a viewport.
// Requires dev server on :8888 (npm run dev).
// Usage: node tools/capture-screenshots.mjs

import { chromium, devices } from '@playwright/test';
import { mkdir, copyFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const outDir = resolve(root, 'screenshots');
const BASE = process.env.BASE_URL || 'http://localhost:8888';

// Pixel 9a: 1080x2424 hw, ~422 ppi → logical 412x924, DPR 2.625
const VIEWPORT = { width: 412, height: 924 };
const DPR = 2.625;

const BOARD_POSITIONS = '5,12,-1,-1,18,25,-1,-1,32,38,-1,-1,45,2,-1,-1';
// Default seat config maps PLAYER to index 2. Put human at [56,56,56,50] (any roll advances, single movable token).
// Leave bots at home (-1) so the game stays open until the human finishes → allHumansDoneVsBots fires game-end.
const NEAR_END_POSITIONS = '-1,-1,-1,-1,-1,-1,-1,-1,56,56,56,50,-1,-1,-1,-1';
const NEAR_END_PLAYER = '2';

async function startGame(p, query = '') {
    await p.goto(`${BASE}/${query}`, { waitUntil: 'domcontentloaded' });
    await p.waitForSelector('wc-quick-start .new-game-btn', { state: 'visible', timeout: 15000 });
    await p.waitForTimeout(200);
    await p.click('wc-quick-start .new-game-btn');
    await p.waitForSelector('wc-quick-start .start-btn', { state: 'visible', timeout: 15000 });
    await p.waitForTimeout(200);
    await p.click('wc-quick-start .start-btn');
    await p.waitForSelector('wc-board:not(.hidden)', { timeout: 15000 });
    await waitVisible(p, '#g-pause-btn');
}

const scenes = [
    { name: 'home', go: async (p) => {
        await p.goto(`${BASE}/`);
        await waitVisible(p, 'wc-quick-start .new-game-btn');
        await p.waitForTimeout(500);
    } },
    { name: 'setup', go: async (p) => {
        await p.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
        await p.waitForSelector('wc-quick-start .new-game-btn', { state: 'visible', timeout: 15000 });
        await p.waitForTimeout(200);
        await p.click('wc-quick-start .new-game-btn');
        await p.waitForSelector('wc-quick-start .start-btn', { state: 'visible', timeout: 15000 });
        await p.waitForTimeout(400);
    } },
    { name: 'settings', go: async (p) => {
        await p.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
        await p.waitForSelector('wc-quick-start wc-settings #settings-icon', { state: 'visible', timeout: 15000 });
        await p.waitForTimeout(400);
        await p.click('wc-quick-start wc-settings #settings-icon');
        // Fallback: if overlay didn't open within 2s, retry the click once.
        try {
            await p.waitForSelector('#settings-overlay:not(.hidden)', { timeout: 2000 });
        } catch {
            await p.click('wc-quick-start wc-settings #settings-icon');
            await p.waitForSelector('#settings-overlay:not(.hidden)', { timeout: 5000 });
        }
        await p.waitForTimeout(400);
    } },
    { name: 'board', go: async (p) => {
        await startGame(p, `?positions=${BOARD_POSITIONS}&player=0`);
        await p.waitForTimeout(800);
    } },
    { name: 'pause', go: async (p) => {
        await startGame(p, `?positions=${BOARD_POSITIONS}&player=0`);
        await p.waitForTimeout(400);
        await p.click('#g-pause-btn');
        await waitVisible(p, '#pause-menu:not(.hidden)');
        await p.waitForTimeout(300);
    } },
    { name: 'game-end', go: async (p) => {
        // P0 has 3 tokens finished + 1 on 55 (one short). Assists drive autoplay to the win.
        await p.addInitScript(() => {
            try {
                localStorage.setItem('assist-auto-roll', 'true');
                localStorage.setItem('assist-auto-single', 'true');
                localStorage.setItem('assist-auto-home-out', 'true');
            } catch {}
        });
        await startGame(p, `?positions=${NEAR_END_POSITIONS}&player=${NEAR_END_PLAYER}`);
        await p.waitForSelector('wc-game-end .game-end-title', { timeout: 90000 });
        await p.waitForTimeout(1000);
    } },
    { name: 'changelog', go: async (p) => { await p.goto(`${BASE}/changelog.html`); await waitVisible(p, 'article'); await p.waitForTimeout(300); } },
    { name: 'privacy', go: async (p) => { await p.goto(`${BASE}/privacy.html`); await waitVisible(p, 'h1, h2'); await p.waitForTimeout(300); } },
];

async function waitVisible(page, sel) {
    await page.waitForSelector(sel, { state: 'visible', timeout: 10000 });
}

async function main() {
    await mkdir(outDir, { recursive: true });

    const skip = new Set((process.env.SKIP_SCENES || '').split(',').map(s => s.trim()).filter(Boolean));
    const only = new Set((process.env.ONLY_SCENES || '').split(',').map(s => s.trim()).filter(Boolean));

    const browser = await chromium.launch();
    for (const theme of ['light', 'dark']) {
        const ctx = await browser.newContext({
            viewport: VIEWPORT,
            deviceScaleFactor: DPR,
            colorScheme: theme,
        });
        await ctx.addInitScript((t) => {
            try {
                localStorage.setItem('theme', t);
                // Clear any saved game so home renders the no-resume layout.
                localStorage.removeItem('ludo-save');
            } catch {}
        }, theme);

        for (const scene of scenes) {
            if (skip.has(scene.name)) { console.log(`- skip ${scene.name}-${theme}`); continue; }
            if (only.size && !only.has(scene.name)) continue;
            const page = await ctx.newPage();
            try {
                await scene.go(page);
                await page.waitForTimeout(300); // settle animations
                const file = resolve(outDir, `${scene.name}-${theme}.png`);
                await page.screenshot({ path: file, fullPage: false });
                console.log(`✓ ${scene.name}-${theme}.png`);
            } catch (e) {
                console.warn(`✗ ${scene.name}-${theme}: ${e.message}`);
            } finally {
                await page.close();
            }
        }
        await ctx.close();
    }
    await browser.close();

    // Copy logo alongside screenshots.
    const logoSrc = resolve(root, 'design/icon-512.png');
    const logoDst = resolve(outDir, 'logo.png');
    await copyFile(logoSrc, logoDst);
    console.log(`✓ logo.png`);

    console.log(`\nDone → ${outDir}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
