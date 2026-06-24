#!/usr/bin/env node
// Capture screenshots for marketing/store at Pixel 9a viewport.
// Requires `npm run dev` (static site on :8888 AND the multiplayer ws server on
// :8890 with DEV_TEST_HOOKS — the online scenes connect to it, and online-exit
// relies on the ?grace/?exitCountdown test hooks the dev mp-server honours).
// Usage: node tools/capture-screenshots.mjs

import { chromium, devices } from '@playwright/test';
import { mkdir, copyFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const outDir = resolve(root, 'dev-assets/screenshots');
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

// --- Online (multiplayer) helpers ---------------------------------------
// Seed the remembered display name BEFORE navigating (the connect carries it
// and the lobby pre-fills it), mirroring test/e2e/helpers.js#openOnline.
async function seedName(p, name) {
    await p.addInitScript((n) => { try { localStorage.setItem('leludo-username', n); } catch {} }, name);
}

// Home → Online segment → New game → <wc-play-online> mounted. Optional query
// (e.g. ?grace=…&exitCountdown=…) rides the initial navigation.
async function goOnline(p, query = '') {
    await p.goto(`${BASE}/${query}`, { waitUntil: 'domcontentloaded' });
    await waitVisible(p, '[data-testid="home-mode-online"]');
    await p.waitForTimeout(150);
    await p.click('[data-testid="home-mode-online"]');
    await p.click('[data-testid="home-new-game"]');
    await waitVisible(p, 'wc-play-online');
}

// Wait until the lobby shows a minted 4-char room code (the socket connected).
async function waitRoomCode(p) {
    await p.waitForFunction(() => {
        const c = document.querySelector('[data-testid="online-room-code"]');
        return !!c && c.textContent.trim().length === 4;
    }, null, { timeout: 15000 });
    return (await p.textContent('[data-testid="online-room-code"]')).trim();
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
        await p.waitForSelector('wc-game-end .ge-headline', { timeout: 90000 });
        await p.waitForTimeout(1000);
    } },
    // Online entry: join-by-code + "create a room". No backend needed.
    { name: 'online-entry', go: async (p) => {
        await goOnline(p);
        await waitVisible(p, '[data-testid="online-create"]');
        await p.waitForTimeout(400);
    } },
    // Online lobby: host a room solo → minted code, share invite, seat list.
    // Needs the mp ws server (the code is minted client-side, the seats arrive
    // once the socket connects).
    { name: 'online-lobby', go: async (p) => {
        await goOnline(p);
        await p.click('[data-testid="online-create"]');
        await waitRoomCode(p);
        await waitVisible(p, '[data-testid="online-seat-1"]');
        await p.waitForTimeout(500);
    } },
    // Online exit: the in-game menu button is a LEAVE, not pause — it opens a
    // countdown confirmation. Needs two real humans (bots don't satisfy the
    // start minimum), so spin up a guest context, join + start, then open the
    // exit dialog on the host. Mirrors test/e2e/online-exit.spec.js.
    { name: 'online-exit', go: async (p, { browser, theme }) => {
        const OPTS = '?grace=60000&exitCountdown=60';
        const guestCtx = await makeContext(browser, theme);
        const guest = await guestCtx.newPage();
        try {
            await seedName(p, 'You');
            await goOnline(p, OPTS);
            await p.click('[data-testid="online-create"]');
            const code = await waitRoomCode(p);

            await seedName(guest, 'Sam');
            await goOnline(guest, OPTS);
            await guest.fill('[data-testid="online-code-input"]', code);
            await guest.click('[data-testid="online-join"]');

            // Guest seats diagonally opposite (seat 2); start once they land.
            await p.waitForFunction(
                () => /Sam/.test(document.querySelector('[data-testid="online-seat-2"]')?.textContent || ''),
                null, { timeout: 15000 });
            await p.click('[data-testid="online-start"]');
            await waitVisible(p, 'wc-board:not(.hidden)');
            await waitVisible(p, '#g-pause-btn');
            await p.waitForTimeout(600);

            await p.click('#g-pause-btn');
            await waitVisible(p, '#online-exit-menu:not(.hidden)');
            await p.waitForTimeout(400);
        } finally {
            await guest.close();
            await guestCtx.close();
        }
    } },
    { name: 'changelog', go: async (p) => { await p.goto(`${BASE}/changelog.html`); await waitVisible(p, 'article'); await p.waitForTimeout(300); } },
    { name: 'privacy', go: async (p) => { await p.goto(`${BASE}/privacy.html`); await waitVisible(p, 'h1, h2'); await p.waitForTimeout(300); } },
];

async function waitVisible(page, sel) {
    await page.waitForSelector(sel, { state: 'visible', timeout: 10000 });
}

// A themed Pixel-9a context with a clean slate. Shared by the per-theme loop and
// the guest context the online-exit scene needs (a live game wants two humans).
async function makeContext(browser, theme) {
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
    return ctx;
}

async function main() {
    await mkdir(outDir, { recursive: true });

    const skip = new Set((process.env.SKIP_SCENES || '').split(',').map(s => s.trim()).filter(Boolean));
    const only = new Set((process.env.ONLY_SCENES || '').split(',').map(s => s.trim()).filter(Boolean));

    const browser = await chromium.launch();
    for (const theme of ['light', 'dark']) {
        const ctx = await makeContext(browser, theme);

        for (const scene of scenes) {
            if (skip.has(scene.name)) { console.log(`- skip ${scene.name}-${theme}`); continue; }
            if (only.size && !only.has(scene.name)) continue;
            const page = await ctx.newPage();
            try {
                await scene.go(page, { browser, theme });
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
    const logoSrc = resolve(root, 'dev-assets/design/icon-512.png');
    const logoDst = resolve(outDir, 'logo.png');
    await copyFile(logoSrc, logoDst);
    console.log(`✓ logo.png`);

    console.log(`\nDone → ${outDir}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
