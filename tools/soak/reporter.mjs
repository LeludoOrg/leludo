/**
 * Reporter — cheap structured output for a soak run.
 *
 *   .local/soak/<runStamp>/
 *     frames.ndjson                 one line per server frame (the per-step record)
 *     repro-<room>-<seq>.json       full bundle per confirmed desync
 *     summary.json                  aggregate pass/fail
 *
 * Frames stream as games run so a crash still leaves a partial log. The process
 * exits non-zero on any confirmed desync (CI-friendly).
 */
import { mkdirSync, createWriteStream, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function createReporter({ outDir, runStamp, logFrames = true, quiet = false }) {
    const runDir = join(outDir, runStamp);
    mkdirSync(runDir, { recursive: true });

    const frameStream = logFrames ? createWriteStream(join(runDir, 'frames.ndjson'), { flags: 'a' }) : null;

    const agg = {
        runStamp,
        startedAt: new Date().toISOString(),
        env: null,
        serverUrl: null,
        config: null,
        totals: {
            games: 0, completed: 0, ended: 0, started: 0,
            framesCompared: 0, faultsInjected: 0,
            gamesWithDesync: 0, desyncs: 0,
            stalled: 0, errored: 0, busy: 0,
        },
        byField: {},        // mismatch field → count
        firstDesync: null,
        desyncs: [],        // compact list (room, seat, field, server, client)
    };

    function log(...a) { if (!quiet) console.log(...a); }

    return {
        runDir,
        setMeta(meta) { agg.env = meta.env; agg.serverUrl = meta.serverUrl; agg.config = meta.config; },

        /** Returns a per-game frame writer that tags each frame with the room. */
        frameWriter(room) {
            if (!frameStream) return () => {};
            return (frame) => {
                try { frameStream.write(JSON.stringify({ room, ...frame }) + '\n'); } catch { /* ignore */ }
            };
        },

        recordGame(result, index, total) {
            agg.totals.games++;
            if (result.started) agg.totals.started++;
            if (result.ended) agg.totals.ended++;
            agg.totals.completed++;
            agg.totals.framesCompared += result.frameCount || 0;
            agg.totals.faultsInjected += result.faults || 0;
            if (result.stalled) agg.totals.stalled++;
            if (result.error) agg.totals.errored++;
            if (result.failReason && result.failReason.startsWith('busy')) agg.totals.busy++;

            if (result.confirmed?.length) {
                agg.totals.gamesWithDesync++;
                agg.totals.desyncs += result.confirmed.length;
                for (const d of result.confirmed) {
                    const field = d.mismatch?.field || 'unknown';
                    agg.byField[field] = (agg.byField[field] || 0) + 1;
                    agg.desyncs.push({
                        room: d.room, seat: d.seat, field, atEnd: d.atEnd, faulted: d.faulted,
                        server: d.mismatch?.server, client: d.mismatch?.client,
                        turn: d.server?.turn, reason: d.reason,
                    });
                    if (!agg.firstDesync) agg.firstDesync = { room: d.room, seat: d.seat, field, turn: d.server?.turn };
                    // Repro bundle.
                    const file = join(runDir, `repro-${d.room}-${d.seat}-${d.seq}.json`);
                    try { writeFileSync(file, JSON.stringify(d, null, 2)); } catch { /* ignore */ }
                }
            }

            const tag = result.confirmed?.length
                ? `DESYNC×${result.confirmed.length} [${result.confirmed.map((d) => d.mismatch?.field).join(',')}]`
                : (result.stalled ? `STALL(${result.failReason})` : (result.error ? 'ERROR' : 'ok'));
            log(`[${index + 1}/${total}] ${result.room} seed=${result.seed} turns=${result.turns} frames=${result.frameCount} ${tag}`);
        },

        finalize() {
            agg.pass = agg.totals.desyncs === 0 && agg.totals.errored === 0;
            agg.finishedAt = new Date().toISOString();
            writeFileSync(join(runDir, 'summary.json'), JSON.stringify(agg, null, 2));
            if (frameStream) frameStream.end();

            if (!quiet) {
                const t = agg.totals;
                console.log('\n— soak summary —');
                console.log(`games: ${t.completed}/${t.games}   ended: ${t.ended}   frames: ${t.framesCompared}`);
                console.log(`desyncs: ${t.desyncs} across ${t.gamesWithDesync} games   stalled: ${t.stalled}   errored: ${t.errored}   busy: ${t.busy}`);
                if (t.faultsInjected) console.log(`faults injected: ${t.faultsInjected}`);
                if (Object.keys(agg.byField).length) console.log('by field:', JSON.stringify(agg.byField));
                if (agg.firstDesync) console.log('first desync:', JSON.stringify(agg.firstDesync));
                console.log(`result: ${agg.pass ? 'PASS ✅' : 'FAIL ❌'}   report: ${runDir}`);
            }
            return agg;
        },
    };
}
