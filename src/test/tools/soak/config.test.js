import { describe, it, expect } from 'vitest';
import { parseArgs, loadConfig, resolveServerUrl, DEFAULTS } from '../../../../tools/soak/config.mjs';

describe('parseArgs', () => {
    it('parses --k=v, --k v, bare flags, and --no-flag', () => {
        const o = parseArgs(['--env=beta', '--seed', '42', '--quiet', '--no-hidden']);
        expect(o).toMatchObject({ env: 'beta', seed: 42, quiet: true, hidden: false });
    });

    it('coerces numbers and booleans, leaves strings', () => {
        const o = parseArgs(['--concurrentGames=8', '--logFrames=false', '--strictness=strict']);
        expect(o.concurrentGames).toBe(8);
        expect(o.logFrames).toBe(false);
        expect(o.strictness).toBe('strict');
    });

    it('builds nested fault config from dotted keys', () => {
        const o = parseArgs(['--faults.dropProb=0.1', '--faults.throttle.batchMs=250', '--faults.reconnect.atTurn=20']);
        expect(o.faults).toEqual({ dropProb: 0.1, throttle: { batchMs: 250 }, reconnect: { atTurn: 20 } });
    });

    it('parses --faultSeats as a numeric list and --i-understand-prod', () => {
        const o = parseArgs(['--faultSeats=0,2', '--i-understand-prod']);
        expect(o.faultSeats).toEqual([0, 2]);
        expect(o.confirmProd).toBe(true);
    });
});

describe('resolveServerUrl', () => {
    it('maps env → ws URL and honours an explicit override', () => {
        expect(resolveServerUrl({ env: 'local' })).toMatch(/^ws:\/\/localhost:/);
        expect(resolveServerUrl({ env: 'beta' })).toBe('wss://mp-beta.leludo.org');
        expect(resolveServerUrl({ env: 'prod' })).toBe('wss://mp.leludo.org');
        expect(resolveServerUrl({ env: 'prod', serverUrl: 'ws://x:1' })).toBe('ws://x:1');
    });
});

describe('loadConfig precedence + derivation', () => {
    it('applies defaults and resolves the local URL', () => {
        const { config } = loadConfig({ argv: [], env: {} });
        expect(config.env).toBe('local');
        expect(config.serverUrl).toMatch(/^ws:\/\/localhost:/);
        expect(config.strictness).toBe(DEFAULTS.strictness);
    });

    it('CLI overrides env overrides defaults', () => {
        const { config } = loadConfig({ argv: ['--seed=99'], env: { SOAK_SEED: '5', SOAK_STRICTNESS: 'strict' } });
        expect(config.seed).toBe(99);        // CLI wins
        expect(config.strictness).toBe('strict'); // env wins over default
    });

    it('derives roomSize from the seat mix', () => {
        expect(loadConfig({ argv: ['--seatMix=humans', '--players=2'], env: {} }).config.roomSize).toBe(2);
        expect(loadConfig({ argv: ['--seatMix=humans+bots', '--players=2'], env: {} }).config.roomSize).toBe(4);
    });

    it('refuses beta/prod without explicit opt-in', () => {
        expect(() => loadConfig({ argv: ['--env=prod'], env: {} })).toThrow(/opt-in/i);
    });

    it('caps concurrency/runs on beta/prod once opted in', () => {
        const { config, warnings } = loadConfig({
            argv: ['--env=beta', '--i-understand-prod', '--games=40', '--runs=500'], env: {},
        });
        expect(config.concurrentGames).toBeLessThanOrEqual(5);
        expect(config.totalRuns).toBeLessThanOrEqual(20);
        expect(warnings.length).toBeGreaterThan(0);
    });
});
