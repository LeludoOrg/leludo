/**
 * worker_threads entry — hosts ONE headless soak client in its own realm.
 *
 * One client per worker is mandatory: the client modules use module-level
 * singletons (state, _seat, turnCount), so a second client in the same realm
 * would clobber the first. The worker boundary also gives true parallelism for
 * 10s of concurrent games.
 *
 * Protocol (parentPort):
 *   ← from main: { cmd: 'roll' | 'move' | 'forceReconnect' | 'close', token? }
 *   → to main:   every SoakClient emit() (seated/lobby/started/frame/observation/
 *                ended/busy/…), each tagged with this worker's seat.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { SoakClient } from './client-harness.mjs';
import { makeRng } from '../../../../src/scripts/core/game-driver.js';

const { url, room, session, name, params, faultConfig, seed, hidden, strictness, convergenceFrames, flushTicks } = workerData;

// Seeded PRNG for fault decisions so a faulted run is reproducible from its seed.
const faultControl = {
    config: faultConfig || {},
    rng: makeRng((seed >>> 0) ^ 0x9e3779b9),
    current: null,
    onFault: (info) => parentPort.postMessage({ type: 'fault', ...info }),
};

const client = new SoakClient({
    url, room, session, name, params,
    faultControl,
    hidden,
    strictness,
    convergenceFrames,
    flushTicks,
    emit: (o) => { try { parentPort.postMessage(o); } catch { /* main gone */ } },
});

parentPort.on('message', (m) => {
    switch (m?.cmd) {
        case 'start': client.start(); break;
        case 'roll': client.roll(); break;
        case 'move': client.move(m.token); break;
        case 'forceReconnect': client.forceReconnect(); break;
        case 'close': client.close(); break;
        default: break;
    }
});

client.boot().catch((e) => {
    parentPort.postMessage({ type: 'boot-error', message: String((e && e.stack) || e) });
});
