/**
 * Orchestrator — the soak loop. Keeps `concurrentGames` matches in flight and
 * launches new ones until `totalRuns` games have run (or `durationMs` elapses).
 * Each game gets a unique room and a per-game seed (seed + gameIndex) so a run is
 * reproducible. Results stream into the reporter as games finish.
 *
 * The concurrency cap doubles as admission-safety: keep it ≤ the server's
 * MAX_CONCURRENT_GAMES and a soak can't trip the capacity gate.
 */
import { runGame } from './game-runner.mjs';

export async function runSoak(config, reporter) {
    reporter.setMeta({ env: config.env, serverUrl: config.serverUrl, config });

    const startTime = Date.now();
    const useDuration = !!config.durationMs;
    let launched = 0;
    let completed = 0;
    let gameIndex = 0;

    const reachedBudget = () => (useDuration ? (Date.now() - startTime) >= config.durationMs : launched >= config.totalRuns);
    const totalForDisplay = useDuration ? '∞' : config.totalRuns;

    const faultSeats = config.faultSeats || [];
    const faultsActive = config.faultsAll || faultSeats.length > 0
        || hasActiveFault(config.faults);

    const inFlight = new Set();

    function launchOne() {
        const idx = gameIndex++;
        launched++;
        const room = mintRoom(config.runStamp, idx);
        const seed = config.seed + idx;
        const onFrame = config.logFrames ? reporter.frameWriter(room) : undefined;

        const p = runGame({
            url: config.serverUrl,
            room,
            seed,
            players: config.playersPerGame,
            roomSize: config.roomSize,
            strictness: config.strictness,
            convergenceFrames: config.convergenceFrames,
            flushTicks: config.flushTicks,
            movePolicy: config.movePolicy,
            hidden: config.hidden,
            maxTurns: config.maxTurns,
            gameTimeoutMs: config.gameTimeoutMs,
            faults: faultsActive ? config.faults : undefined,
            faultSeats,
            faultsAll: config.faultsAll,
            onFrame,
        }).then((res) => {
            reporter.recordGame(res, completed++, useDuration ? completed : config.totalRuns);
        }).catch((err) => {
            reporter.recordGame({ room, seed, frameCount: 0, turns: 0, error: String(err && err.stack || err), failed: true, failReason: 'runner-throw', confirmed: [] }, completed++, config.totalRuns);
        }).finally(() => {
            inFlight.delete(p);
        });
        inFlight.add(p);
    }

    if (!config.quiet) {
        console.log(`soak: ${config.env} (${config.serverUrl})  games=${totalForDisplay}  concurrency=${config.concurrentGames}  players=${config.playersPerGame}/${config.roomSize}  strictness=${config.strictness}${faultsActive ? '  faults=ON' : ''}`);
    }

    while (!reachedBudget() || inFlight.size) {
        while (inFlight.size < config.concurrentGames && !reachedBudget()) launchOne();
        if (inFlight.size) await Promise.race(inFlight);
    }

    return reporter.finalize();
}

function hasActiveFault(faults) {
    if (!faults) return false;
    return faults.dropProb > 0 || faults.delayMs > 0 || faults.reorderProb > 0 || !!faults.throttle || !!faults.reconnect;
}

/** Unique room per game (server accepts any room id; uniqueness avoids cross-game
 *  collisions across a run). */
function mintRoom(runStamp, idx) {
    const stamp = String(runStamp).replace(/[^0-9A-Za-z]/g, '').slice(-6);
    return `SK${stamp}${idx.toString(36).toUpperCase()}`;
}
