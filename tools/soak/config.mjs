/**
 * Soak harness configuration: schema + defaults + (CLI > env > JSON > defaults)
 * merge + env→server-URL resolution + prod/beta guardrails.
 *
 * Mirrors net-client.resolveServerUrl on the server side (local → :8890,
 * beta/prod → the deployed Workers) but always passes the resolved URL to
 * NetClient.opts.url, so the Node workers never depend on location/hostname.
 */
import { readFileSync } from 'node:fs';

const ENV_URL = {
    local: () => `ws://localhost:${process.env.MP_PORT || 8890}`,
    beta: () => 'wss://mp-beta.leludo.org',
    prod: () => 'wss://mp.leludo.org',
};

export const DEFAULTS = Object.freeze({
    env: 'local',                 // local | beta | prod
    serverUrl: null,              // explicit override (wins over env)
    backend: 'worker',            // worker | browser

    concurrentGames: 8,           // parallel matches in flight
    playersPerGame: 2,            // human workers we drive (2..4)
    roomSize: null,               // total active seats; null → derived from seatMix
    seatMix: 'humans',            // humans | humans+bots | 1human+bots

    totalRuns: 50,                // terminate after N games (or durationMs)
    durationMs: null,

    seed: 7,                      // master seed; per-game seed = seed + gameIndex
    strictness: 'eventual',       // strict | positions-only | eventual
    convergenceFrames: 3,         // frames a mismatch must persist to confirm
    flushTicks: 4,                // macrotask ticks to drain the client chain/frame
    movePolicy: 'random',         // random | first
    hidden: true,                 // run clients as backgrounded tabs (fast + bug-path)

    faults: {                     // all off → clean soak
        dropProb: 0,              // P(drop an inbound frame)
        delayMs: 0,               // hold each inbound frame this long
        reorderProb: 0,           // P(swap a frame with the next)
        throttle: null,           // { batchMs } batch+defer inbound frames
        reconnect: null,          // { atTurn, count } force mid-game reconnects
    },
    faultSeats: [],               // which human seats get faults ([] + faultsAll=false → none)
    faultsAll: false,             // apply faults to every human seat

    outDir: '.local/soak',
    logFrames: true,              // stream per-frame server records to NDJSON
    maxTurns: 600,                // per-game stall guard
    gameTimeoutMs: 60000,
    quiet: false,

    confirmProd: false,           // required to target beta/prod (--i-understand-prod)
});

const NUMERIC = new Set(['concurrentGames', 'playersPerGame', 'roomSize', 'totalRuns', 'durationMs', 'seed', 'convergenceFrames', 'flushTicks', 'maxTurns', 'gameTimeoutMs']);
const BOOL = new Set(['hidden', 'logFrames', 'quiet', 'faultsAll', 'confirmProd']);

function coerce(v) {
    if (v === 'true') return true;
    if (v === 'false') return false;
    if (v !== '' && v != null && !Number.isNaN(Number(v)) && /^-?\d/.test(String(v))) return Number(v);
    return v;
}

/** Set a possibly-dotted key path on an object (e.g. faults.throttle.batchMs). */
function setPath(obj, path, value) {
    const parts = path.split('.');
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
        if (typeof cur[parts[i]] !== 'object' || cur[parts[i]] == null) cur[parts[i]] = {};
        cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = value;
}

/** Parse argv into a flat/nested overrides object. Supports --k=v, --k v, --flag,
 *  --no-flag, --faults.dropProb=0.1, --faultSeats=0,2. */
export function parseArgs(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i++) {
        const tok = argv[i];
        if (!tok.startsWith('--')) continue;
        let key = tok.slice(2);
        let val;
        if (key.startsWith('no-')) { setPath(out, key.slice(3), false); continue; }
        if (key.includes('=')) { [key, val] = splitOnce(key, '='); }
        else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) { val = argv[++i]; }
        else { val = 'true'; }
        if (key === 'i-understand-prod') { out.confirmProd = true; continue; }
        if (key === 'faultSeats') { out.faultSeats = String(val).split(',').filter((s) => s !== '').map(Number); continue; }
        setPath(out, key, coerce(val));
    }
    return out;
}

function splitOnce(s, sep) {
    const i = s.indexOf(sep);
    return [s.slice(0, i), s.slice(i + 1)];
}

function envOverrides(env = process.env) {
    const o = {};
    if (env.SOAK_ENV) o.env = env.SOAK_ENV;
    if (env.SOAK_SERVER_URL) o.serverUrl = env.SOAK_SERVER_URL;
    if (env.SOAK_GAMES) o.concurrentGames = Number(env.SOAK_GAMES);
    if (env.SOAK_RUNS) o.totalRuns = Number(env.SOAK_RUNS);
    if (env.SOAK_SEED) o.seed = Number(env.SOAK_SEED);
    if (env.SOAK_PLAYERS) o.playersPerGame = Number(env.SOAK_PLAYERS);
    if (env.SOAK_STRICTNESS) o.strictness = env.SOAK_STRICTNESS;
    return o;
}

function deepMerge(base, over) {
    const out = Array.isArray(base) ? base.slice() : { ...base };
    for (const [k, v] of Object.entries(over || {})) {
        if (v && typeof v === 'object' && !Array.isArray(v) && typeof out[k] === 'object' && out[k] != null) {
            out[k] = deepMerge(out[k], v);
        } else {
            out[k] = v;
        }
    }
    return out;
}

function coerceTypes(cfg) {
    for (const k of NUMERIC) if (cfg[k] != null && cfg[k] !== '') cfg[k] = Number(cfg[k]);
    for (const k of BOOL) if (typeof cfg[k] === 'string') cfg[k] = cfg[k] === 'true';
    return cfg;
}

/** Resolve env (or explicit) → ws URL. */
export function resolveServerUrl(cfg) {
    if (cfg.serverUrl) return cfg.serverUrl;
    const f = ENV_URL[cfg.env];
    if (!f) throw new Error(`Unknown env "${cfg.env}" (expected local|beta|prod)`);
    return f();
}

/** Derive total room size from the seat mix + driven players. */
function deriveRoomSize(cfg) {
    if (cfg.roomSize) return Math.max(2, Math.min(4, cfg.roomSize));
    if (cfg.seatMix === 'humans') return Math.max(2, Math.min(4, cfg.playersPerGame));
    return 4; // humans+bots / 1human+bots fill the rest of a 4-seat room with bots
}

/**
 * Build the effective config from argv + env + optional --config JSON. Applies
 * prod/beta guardrails (explicit opt-in + low caps) so a soak can't quietly burn
 * the shared daily/concurrency limits.
 * @returns {{config:object, warnings:string[]}}
 */
export function loadConfig({ argv = [], env = process.env } = {}) {
    const cli = parseArgs(argv);
    let fileCfg = {};
    if (cli.config) {
        try { fileCfg = JSON.parse(readFileSync(cli.config, 'utf8')); }
        catch (e) { throw new Error(`Failed to read --config ${cli.config}: ${e.message}`); }
    }
    let cfg = deepMerge(DEFAULTS, fileCfg);
    cfg = deepMerge(cfg, envOverrides(env));
    cfg = deepMerge(cfg, cli);
    cfg = coerceTypes(cfg);

    cfg.playersPerGame = Math.max(2, Math.min(4, cfg.playersPerGame));
    cfg.roomSize = deriveRoomSize(cfg);
    if (cfg.playersPerGame > cfg.roomSize) cfg.playersPerGame = cfg.roomSize;
    cfg.serverUrl = resolveServerUrl(cfg);

    const warnings = [];
    const isShared = cfg.env === 'beta' || cfg.env === 'prod';
    if (isShared && !cfg.serverUrlExplicitLocal) {
        if (!cfg.confirmProd) {
            throw new Error(`Targeting "${cfg.env}" needs explicit opt-in: pass --i-understand-prod (it shares real admission caps).`);
        }
        if (cfg.concurrentGames > 5) { warnings.push(`capped concurrentGames ${cfg.concurrentGames}→5 for ${cfg.env}`); cfg.concurrentGames = 5; }
        if (cfg.totalRuns > 20) { warnings.push(`capped totalRuns ${cfg.totalRuns}→20 for ${cfg.env}`); cfg.totalRuns = 20; }
        if (cfg.faults?.reconnect?.count > 1) { warnings.push(`capped reconnect.count for ${cfg.env}`); cfg.faults.reconnect.count = 1; }
    }

    return { config: cfg, warnings };
}
