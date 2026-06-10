import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { RECORDINGS_DIR } from '../../../tools/clear-recordings.mjs';

/**
 * End-to-end ONLINE MULTIPLAYER sessions — the real index.html UI, driven across
 * many isolated browser CONTEXTS (one per player). A single browser process hosts
 * every context, so N players cost ~N tabs, not N browsers — the minimal-footprint
 * way to fake "different devices" (each context = its own localStorage, username,
 * session id, and socket). All players talk to the real Node ws server Playwright
 * starts (server/local-server.mjs on 8890); nothing is mocked.
 *
 * Every player's screen is VIDEO-RECORDED into recordings/online/ with a
 * descriptive name, so the last run can be reviewed. Recordings are wiped at the
 * start of each run via `npm run test:e2e:online` (tools/clear-recordings.mjs);
 * descriptive filenames also overwrite in place, so the folder always reflects the
 * most recent run. Videos are saved even when a scenario FAILS (try/finally), so a
 * broken run is reviewable too.
 *
 * Scenarios cover: 2-human head-to-head, a full 4-human table (mixed join-by-code
 * + invite-link), host-vs-bots, host moderation (kick + refill), a session that
 * reaches the end screen via forfeit, and a non-deterministic fuzz loop that
 * randomises player count, colours, join methods and bot fills across games.
 *
 * Server-authoritative lockstep (raw board equality) is already covered against
 * the debug harness in multiplayer.spec.js; here we assert the player-facing
 * truth: every client mounts the board, sits at its own bottom-right perspective,
 * and the turn keeps flowing for everyone (no stall).
 */

// ---------------------------------------------------------------------------
// Non-deterministic RNG. Default seed varies per run; set MP_FUZZ_SEED to a
// fixed number to reproduce a failing fuzz run. The seed is logged + attached.
// ---------------------------------------------------------------------------
function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a |= 0; a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];
const rint = (rng, lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));

const NAME_POOL = ['Aria', 'Bolt', 'Cleo', 'Dax', 'Echo', 'Finn', 'Gus', 'Hex', 'Iris', 'Jet', 'Kit', 'Lux'];
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
const RAW_DIR = join(RECORDINGS_DIR, '.raw');

// ---------------------------------------------------------------------------
// One "player device" = its own browser context (isolated storage + session).
// ---------------------------------------------------------------------------
async function makeUser(browser, { name }) {
    const ctx = await browser.newContext({
        viewport: { width: 500, height: 880 }, // phone-ish portrait — board fits
        recordVideo: { dir: RAW_DIR, size: { width: 500, height: 880 } },
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e}`));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
    const user = { ctx, page, name, errors, closed: false, video: page.video() };

    // Home → Play online → enter name (saves username, enabling invite-link auto-join).
    await page.goto('/');
    await page.getByTestId('home-play-online').dispatchEvent('click');
    await page.getByTestId('online-name').fill(name);
    return user;
}

/** Close a player's context (finalising its video) and save it under a readable
 *  name. Idempotent — safe to call again in a finally even after an early leave. */
async function finalizeUser(user, label) {
    if (user.closed) return;
    user.closed = true;
    const video = user.video;
    try { await user.ctx.close(); } catch { /* already gone */ }
    if (video) {
        try {
            await video.saveAs(join(RECORDINGS_DIR, `${label}.webm`));
            await video.delete().catch(() => {});
        } catch { /* recording may not exist if the page never opened */ }
    }
}

async function finalizeAll(users, scenario) {
    for (const u of users) await finalizeUser(u, `${slug(scenario)}-${slug(u.name)}`);
}

/** Fail the test if any player hit an uncaught exception / console error. */
function assertNoErrors(users) {
    const all = users.flatMap((u) => u.errors.map((e) => `[${u.name}] ${e}`));
    expect(all, `runtime errors:\n${all.join('\n')}`).toHaveLength(0);
}

// ---------------------------------------------------------------------------
// Lobby helpers.
// ---------------------------------------------------------------------------
async function createRoom(host, { color } = {}) {
    if (color != null) await host.page.getByTestId(`online-color-${color}`).click();
    await host.page.getByTestId('online-create').click();
    await expect(host.page.getByTestId('online-room-code')).toBeVisible();
    const code = (await host.page.getByTestId('online-room-code').textContent())?.trim();
    expect(code).toMatch(/^[A-Z0-9]{4}$/);
    await expect(host.page.getByTestId('online-is-host')).toHaveText('true');
    return code;
}

async function joinByCode(user, code) {
    await user.page.getByTestId('online-code-input').fill(code);
    await user.page.getByTestId('online-join').click();
    await expect(user.page.getByTestId('online-room-code')).toHaveText(code);
}

/** Invite-link join: the name is already saved (makeUser typed it), so opening
 *  ?join=CODE drops the player straight into the room lobby. */
async function joinByLink(user, code) {
    await user.page.goto(`/?join=${code}`);
    await expect(user.page.locator('wc-game-room')).toHaveCount(1);
    await expect(user.page.getByTestId('online-room-code')).toHaveText(code);
}

/** Index of the seat this client occupies (the row tagged "(you)"). */
async function mySeatIndex(page) {
    for (let i = 0; i < 4; i++) {
        const row = page.getByTestId(`online-seat-${i}`);
        if (await row.count()) {
            const txt = (await row.textContent()) || '';
            if (/\(you\)/.test(txt)) return i;
        }
    }
    return -1;
}

/** Host fills every still-open seat with a bot. Returns the bot seat indices. */
async function fillOpenSeatsWithBots(host) {
    const filled = [];
    for (let i = 0; i < 4; i++) {
        const btn = host.page.getByTestId(`online-seat-${i}-bot`);
        if (await btn.count() && await btn.isVisible().catch(() => false)) {
            await btn.click();
            await expect(host.page.getByTestId(`online-seat-${i}`)).toContainText('Bot');
            filled.push(i);
        }
    }
    return filled;
}

async function startAndMount(host, humans) {
    await host.page.getByTestId('online-start').click();
    for (const u of humans) {
        await expect(u.page.getByTestId('online-started')).toHaveText('true', { timeout: 15_000 });
        await expect(u.page.locator('wc-board .board-grid')).toBeVisible({ timeout: 15_000 });
        await expect(u.page.locator('wc-token')).toHaveCount(16);
        // Perspective parity with offline: every client renders ITSELF bottom-right (pos 2).
        await expect(u.page.locator('#p-2-0')).toBeVisible();
    }
}

// ---------------------------------------------------------------------------
// Gameplay driver. Each tick, every human force-clicks the dice then any
// activated token; the server ignores out-of-turn input, so only the player
// whose turn it is actually advances. We poll the turn counter (shared by every
// client) until it climbs past `minTurns` — proof the roll→render→advance loop
// runs end-to-end for the whole table, not just the host.
// ---------------------------------------------------------------------------
async function readTurn(page) {
    const t = (await page.locator('#turn-counter').textContent().catch(() => '')) || '';
    const n = parseInt(t.replace(/\D/g, ''), 10);
    return Number.isFinite(n) ? n : 0;
}

async function drivePlies(humans, { minTurns = 4, timeout = 30_000 } = {}) {
    await expect
        .poll(async () => {
            for (const u of humans) {
                await u.page.locator('wc-dice').click({ force: true }).catch(() => {});
                const tok = u.page.locator('wc-token .animate-bounce').first();
                if (await tok.count()) await tok.click({ force: true }).catch(() => {});
            }
            const turns = await Promise.all(humans.map((u) => readTurn(u.page)));
            return Math.max(0, ...turns);
        }, { timeout, intervals: [350, 350, 350] })
        .toBeGreaterThanOrEqual(minTurns);

    // Every human's board must have advanced — none left stalled on turn 0.
    for (const u of humans) {
        await expect.poll(() => readTurn(u.page), { timeout: 10_000 }).toBeGreaterThan(0);
    }
}

// Bound concurrency-heavy multi-context tests; run via `npm run test:e2e:online`
// (which also wipes recordings/online/ first via tools/clear-recordings.mjs).
test.describe('Online multiplayer — recorded sessions', () => {
    test('2 players head-to-head: host creates, guest joins by code, both play', async ({ browser }) => {
        const scenario = 'duel';
        const users = [];
        try {
            const host = await makeUser(browser, { name: 'Hosty' });
            const guest = await makeUser(browser, { name: 'Guesty' });
            users.push(host, guest);

            const code = await createRoom(host, { color: 2 });
            await expect(host.page.getByTestId('online-seat-2')).toContainText('(you)'); // host holds picked colour

            await joinByCode(guest, code);
            // Roles: host sees Start, guest waits; each sees the other in the lobby.
            await expect(guest.page.getByTestId('online-is-host')).toHaveText('false');
            await expect(guest.page.getByTestId('online-start')).toBeHidden();
            await expect(host.page.locator('.seat-list')).toContainText('Guesty');
            await expect(guest.page.locator('.seat-list')).toContainText('Hosty');

            await startAndMount(host, users);
            await drivePlies(users, { minTurns: 5 });

            assertNoErrors(users);
        } finally {
            await finalizeAll(users, scenario);
        }
    });

    test('4 players full table: mixed join-by-code + invite-link, all play', async ({ browser }) => {
        const scenario = 'full-table';
        const users = [];
        try {
            const host = await makeUser(browser, { name: 'Aria' });
            const g1 = await makeUser(browser, { name: 'Bolt' });
            const g2 = await makeUser(browser, { name: 'Cleo' });
            const g3 = await makeUser(browser, { name: 'Dax' });
            users.push(host, g1, g2, g3);

            const code = await createRoom(host, { color: 0 });
            await joinByCode(g1, code);   // one joins by typing the code
            await joinByLink(g2, code);   // one taps a shared invite link
            await joinByCode(g3, code);

            // Host sees all four humans seated before starting.
            for (const u of users) await expect(host.page.locator('.seat-list')).toContainText(u.name);
            // No open seats left → starting needs no bot fill; it's a 4-human table.

            await startAndMount(host, users);
            await drivePlies(users, { minTurns: 5 });

            assertNoErrors(users);
        } finally {
            await finalizeAll(users, scenario);
        }
    });

    test('host vs bots: one human fills the table with bots and plays', async ({ browser }) => {
        const scenario = 'host-vs-bots';
        const users = [];
        try {
            const host = await makeUser(browser, { name: 'Solo' });
            users.push(host);

            await createRoom(host, { color: 1 });
            const bots = await fillOpenSeatsWithBots(host);
            expect(bots).toHaveLength(3); // 3 open seats → 3 bots

            await startAndMount(host, users);
            await drivePlies(users, { minTurns: 8 }); // longer run: bot turns auto-advance

            assertNoErrors(users);
        } finally {
            await finalizeAll(users, scenario);
        }
    });

    test('host moderation: kick a guest, refill the seat with a bot, then play', async ({ browser }) => {
        const scenario = 'kick-refill';
        const users = [];
        try {
            const host = await makeUser(browser, { name: 'Boss' });
            const guest = await makeUser(browser, { name: 'Leaver' });
            users.push(host, guest);

            const code = await createRoom(host, {});
            await joinByCode(guest, code);

            // Find the guest's seat row and kick it.
            const guestSeat = await mySeatIndex(guest.page);
            expect(guestSeat).toBeGreaterThanOrEqual(0);
            await expect(host.page.getByTestId(`online-seat-${guestSeat}-kick`)).toBeVisible();
            await host.page.getByTestId(`online-seat-${guestSeat}-kick`).click();

            // Guest is bounced back to the online menu with a "removed" notice.
            await expect(guest.page.getByTestId('online-create')).toBeVisible();
            await expect(guest.page.getByTestId('online-status')).toContainText(/removed/i);

            // Host refills the freed seat (and the rest) with bots, then plays solo.
            await fillOpenSeatsWithBots(host);
            await startAndMount(host, [host]);
            await drivePlies([host], { minTurns: 6 });

            assertNoErrors(users);
        } finally {
            await finalizeAll(users, scenario);
        }
    });

    test('session reaches the end screen: a leaver forfeits and the game ends', async ({ browser }) => {
        const scenario = 'forfeit-end';
        const users = [];
        try {
            // Short reconnect grace so the forfeit (and game end) happen quickly.
            // The server honours ?grace only under DEV_TEST_HOOKS (set by Playwright).
            const host = await makeUser(browser, { name: 'Alice' });
            const guest = await makeUser(browser, { name: 'Bob' });
            users.push(host, guest);
            await host.page.goto('/?grace=4000');
            await host.page.getByTestId('home-play-online').dispatchEvent('click');
            await host.page.getByTestId('online-name').fill('Alice');

            const code = await createRoom(host, {});
            await joinByCode(guest, code);
            await expect(host.page.locator('.seat-list')).toContainText('Bob');

            // Start: Alice + Bob are humans, seats fill with bots → 4-handed table.
            await startAndMount(host, users);

            // Bob abandons the game; Alice's board stays live (leaver just dims).
            await finalizeUser(guest, `${slug(scenario)}-${slug(guest.name)}`);
            await expect(host.page.locator('wc-board .board-grid')).toBeVisible();
            await expect(host.page.getByTestId('net-reconnect-banner')).toBeHidden();

            // Grace elapses → Bob forfeits → only one human left → game ends and the
            // recap (.ge-screen) mounts. This is a session that runs to completion.
            await expect(host.page.locator('wc-game-end .ge-screen')).toBeVisible({ timeout: 14_000 });

            assertNoErrors([host]);
        } finally {
            await finalizeAll(users, scenario);
        }
    });

    // -----------------------------------------------------------------------
    // Non-deterministic fuzz: a handful of games with randomised player count,
    // host colour, join methods, and bot fills. Catches stalls/desyncs that only
    // surface in odd seatings. Reproduce a failure by setting MP_FUZZ_SEED.
    // -----------------------------------------------------------------------
    for (let iter = 0; iter < 3; iter++) {
        test(`fuzz session #${iter + 1}: random players / colours / join methods`, async ({ browser }, testInfo) => {
            const baseSeed = process.env.MP_FUZZ_SEED
                ? Number(process.env.MP_FUZZ_SEED) + iter
                : (Date.now() ^ (iter * 0x9e3779b1)) >>> 0;
            const rng = mulberry32(baseSeed);

            const humanCount = rint(rng, 2, 4);
            const hostColor = rint(rng, 0, 3);
            const names = [...NAME_POOL].sort(() => rng() - 0.5).slice(0, humanCount);
            const plan = `seed=${baseSeed} humans=${humanCount} hostColor=${hostColor} names=${names.join(',')}`;
            testInfo.annotations.push({ type: 'fuzz', description: plan });

            const scenario = `fuzz-${iter + 1}`;
            const users = [];
            try {
                const host = await makeUser(browser, { name: names[0] });
                users.push(host);
                const code = await createRoom(host, { color: hostColor });

                for (let i = 1; i < humanCount; i++) {
                    const guest = await makeUser(browser, { name: names[i] });
                    users.push(guest);
                    // Randomly join by typed code or by tapped invite link.
                    if (pick(rng, ['code', 'link']) === 'link') await joinByLink(guest, code);
                    else await joinByCode(guest, code);
                }

                for (const u of users) await expect(host.page.locator('.seat-list')).toContainText(u.name);
                await fillOpenSeatsWithBots(host); // any leftover seats → bots
                await startAndMount(host, users);
                await drivePlies(users, { minTurns: rint(rng, 4, 7) });

                assertNoErrors(users);
            } finally {
                await finalizeAll(users, scenario);
            }
        });
    }
});
