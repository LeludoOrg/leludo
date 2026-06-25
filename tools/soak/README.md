# Multiplayer state-sync soak harness

Runs many concurrent **private** multiplayer matches and, at every game step,
checks that **what each client believes** lines up with **the authoritative
server state**. Built to catch the desync class that has bitten online play
(turn count / board drifting between players) and to be the backbone of
multiplayer testing going forward.

```bash
npm run mp:server            # start the local backend (wrangler dev, port 8890) in one shell
npm run soak                 # run a soak against local in another
npm run soak -- --games=10 --runs=200 --strictness=eventual
```

Exits **non-zero** on any confirmed desync, and writes a report to
`.local/soak/<stamp>/`. CI-ready.

## How it works

The desync lives in the **client** reconcile path (`online-game` →
`command-handler` → `game-reducer` → `render-logic`), so each headless "player"
runs **that exact code**, not a reimplementation:

- **Worker backend (default).** Each client is a `worker_threads` realm running
  the real client modules under happy-dom, connected to the server over a real
  `ws` socket. Module singletons (`state`, `_seat`, `turnCount`) force one client
  per realm. Clients run as a backgrounded tab (`document.hidden`), which makes
  render animations fast-forward (no rAF/transition hang) **and** is the exact
  code path the reported desync occurs on. Scales to 10s of games / 100s of runs.
- **Browser backend (`--backend=browser`).** Each client is a real Chromium tab
  (real WebSocket, real rAF, real event loop) booting the same pipeline against a
  fixture board. Exercises the **visible-tab** animation path the worker skips.
  Capped low (~3 concurrent) — for confirming a worker-found desync with the
  authentic trigger, not bulk runs.

**Server truth.** There is no server state-query API, so the authoritative state
is the `_publicState()` snapshot the server stamps on every `STATE`/`MOVED`
frame. Every client of a game receives the identical broadcast, so each frame is
both the per-step record and the comparison target.

**Comparison.** Server state is seat-indexed; client state is local-board-indexed
(`≤2`-player games use a diagonal re-seat, not a pure rotation). The comparator
projects the client back into seat space using the client's **own** `toServer`
map, then checks: token **positions** per seat, the displayed **turn count**, the
current **player**, **phase**, and **dice** (only while a roll is live). A
mismatch is **confirmed only if it persists** `convergenceFrames` frames — a
client legitimately runs a frame ahead on a three-sixes / no-move pass and
reconverges immediately, and that transient is ignored. The final board is
compared authoritatively after a grace for any trailing (delayed) frames.

## Fault injection

Faults perturb only the **inbound** (server→client) path; client intents always
pass through. All off by default.

| Fault | Flag | Models | Faithful? |
|---|---|---|---|
| drop | `--faults.dropProb=0.1` | a missed `moved` delta (socket blip / swallowed animation) — reconcile should heal it | yes (moved-only; control/turn-sync/catch-up frames are never dropped) |
| delay | `--faults.delayMs=80` | a slow link | yes (FIFO preserved) |
| throttle | `--faults.throttle.batchMs=250` | a backgrounded tab delivering frames in bursts | yes (FIFO preserved) |
| reconnect | `--faults.reconnect.atTurn=20 --faults.reconnect.count=2` | a socket blip → auto-rejoin → server `reason:'reconnect'` catch-up | yes |
| reorder | `--faults.reorderProb=0.2` | out-of-order delivery | **no** — TCP never reorders WebSocket frames; stress-only, may surface non-bugs |

Apply to every human seat with `--faultsAll`, or to specific seats with
`--faultSeats=0,2`.

## Config

CLI **>** env **>** `--config <file>.json` **>** defaults. Common flags
(`tools/soak/config.mjs` is the full schema):

```
--env local|beta|prod          target server (beta/prod require --i-understand-prod)
--games N                       concurrent matches in flight
--runs N                        total games to run (or --durationMs N)
--players N                     human-driven seats per game (2..4)
--seatMix humans|humans+bots|1human+bots
--seed N                        master seed (per-game seed = seed + index)
--strictness strict|positions-only|eventual
--convergenceFrames N           frames a mismatch must persist to confirm (default 3)
--movePolicy random|first
--backend worker|browser
--outDir .local/soak  --no-logFrames  --quiet
```

Env vars: `MP_PORT`, `SOAK_ENV`, `SOAK_SERVER_URL`, `SOAK_GAMES`, `SOAK_RUNS`,
`SOAK_SEED`, `SOAK_PLAYERS`, `SOAK_STRICTNESS`.

### Targeting beta / prod

`beta`/`prod` share real admission caps, so they require explicit opt-in and are
clamped:

```bash
npm run soak -- --env=beta --i-understand-prod --games=3 --runs=10
```

Note: `DEV_TEST_HOOKS` (seeded dice) is **off** on beta/prod, so dice are
non-deterministic there; the comparator still holds (it compares client vs
server), but per-game replay isn't byte-reproducible — the captured frame stream
+ repro bundle are the repro.

## Output

```
.local/soak/<stamp>/
  frames.ndjson                 one line per server frame (the per-step record)
  repro-<room>-<seat>-<seq>.json   full bundle per confirmed desync
  summary.json                  aggregate pass/fail (+ exit code)
```

A repro bundle has the mismatch, the seat-mapped server vs client state, and a
rolling window of the preceding frames.

## Self-test (does the harness still catch a desync?)

Temporarily make the client reconcile a no-op and run a faulted soak — it must go
red. In `src/scripts/state/command-handler.js`, add `return;` at the top of
`netReconcile`, then:

```bash
npm run soak -- --games=4 --runs=6 --faults.dropProb=0.12 --faultsAll
```

Expect `positions` desyncs and a non-zero exit. Revert the edit afterwards.
