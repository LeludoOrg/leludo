# server/cf — Cloudflare production transport

The production multiplayer backend. A Cloudflare **Worker** (`worker.js`) routes
`wss://` upgrades to three **Durable Object** classes that wrap the same
runtime-agnostic engine the local Node server uses:

| File | Wraps | Role |
|---|---|---|
| `worker.js` | — | router: terminates `wss://`, forwards to the owning DO, serves `/health` + `/stats` |
| `room-do.js` → `LudoRoomDO` | `server/room-engine.js` | one instance per game; authoritative state + sockets |
| `admission-do.js` → `AdmissionDO` | `server/admission.js` | singleton hard-capacity gate (persisted counters) |
| `match-do.js` → `MatchmakingDO` | `server/matchmaker.js` | singleton public queue (off the launch path — see file header) |
| `cf-utils.js` | — | shared JSON/env/socket helpers |

All game rules stay in `scripts/*`; these files only move bytes + own sockets
(the DO is a thin transport + state shell).

## Local dev / tests — this IS the dev runtime

`npm run dev` and the Playwright e2e suite run **this Worker** under `wrangler dev`
(local workerd/miniflare) on port 8890, so dev/CI match the deployed Durable Object
semantics exactly — storage, alarms, output gate, and **eviction on reload** (a
wrangler restart wipes the in-memory DOs the way a code deploy does, exercising
persist/restore). The retired Node `ws` server (`server/local-server.mjs`) couldn't
reproduce DO eviction — which is how the "deploy kills the game" bug shipped
undetected (fixed in v0.28.5; see `room-do.js` "Deploy survival").

The dev/e2e backend passes `--var DEV_TEST_HOOKS:1`, which turns on the
deterministic seed / `?grace` override / `__busy__` room the suite needs (gated in
`worker.js` + `room-do.js`; deployed prod never sets it, so the hooks are inert
there — locked by `room-do.workers.test.js`). The client only dials the live
Cloudflare endpoint on a non-localhost host (see `scripts/net-client.js` →
`resolveServerUrl`).

```bash
npm run dev           # static site (8888) + this Worker under wrangler dev (8890)
npm run mp:server     # just the Worker on 8890 (wrangler dev), e.g. for the soak harness
npm run cf:dev        # wrangler dev on the default port 8787
```

## Deploy

```bash
npx wrangler login    # one-time: authorise your Cloudflare account
npm run cf:deploy     # wrangler deploy — applies the v1 DO migration on first run
npm run cf:tail       # live logs
```

`wrangler deploy` reads `wrangler.toml` at the repo root (Worker name
`leludo-mp`, the three DO bindings, the SQLite migration, and the capacity
`[vars]`). CI deploys the same way — see the `deploy-worker` job in
`.github/workflows/release.yml` (prod) and `deploy-worker-beta` in
`.github/workflows/release-beta.yml` (`--env beta`).

## Point the client at it

`scripts/net-client.js` defaults production to `wss://mp.leludo.org`. Two ways to
make that resolve:

1. **Custom domain (recommended).** Add `leludo.org`'s DNS to Cloudflare, then
   uncomment the `[[routes]]` block in `wrangler.toml` and redeploy — wrangler
   creates the `mp` record.
2. **`*.workers.dev` meanwhile.** After the first deploy, override per-browser:
   `localStorage.setItem('leludo-mp-server', 'wss://leludo-mp.<subdomain>.workers.dev')`,
   or append `?server=wss://…` to the URL for a one-off test.

## Capacity safety (Workers Paid plan)

Caps in `[vars]` (`MAX_GAMES_PER_DAY=1000`, `MAX_CONCURRENT_GAMES=250`) keep usage
inside the Workers Paid ($5/mo) plan's **INCLUDED** Durable-Object allowance (no
overage); `AdmissionDO` returns a friendly `{ t:"busy" }` before any limit is
hit. The dominant cost is **SQL rows written: 50,000,000/month included**
(~1.67M/day), shared account-wide across prod + beta (one bucket). The caps stay
the real footgun guard — pair them with a Cloudflare **billing alert** as the
backstop.

`LudoRoomDO` is **resident, not hibernated** (see `room-do.js` header) but **does
persist** a resume snapshot on every state-changing broadcast (v0.28.5). The
WebSocket-hibernation experiment (v0.24.5) also wrote a per-broadcast snapshot, but
its write sat ON CF's output gate — each roll/move frame was held until the write
landed (per-move lag), plus a cold wake on the first move after think-time. The
v0.28.5 persist avoids that by writing with `{ allowUnconfirmed: true }`, OFF the
output gate, so frames go out instantly and a snapshot lost to a crash just re-syncs
from the prior frame on the next reconnect. So the snapshot rows are back (≈570
rows/2p, ~1,668/4p in live data — the dominant per-game cost), but they buy
deploy survival without the latency. The per-day game caps are sized to keep even a
worst-case all-4p day within the 50M rows/month INCLUDED paid allowance (see
`wrangler.toml`).

The other trade is duration (GB-s): a resident DO stays in memory through human
think-time. On the paid plan duration is billed beyond 400,000 GB-s/month
INCLUDED; at ~1000 4p-games/day × ~13 GB-s × 30 ≈ 390k GB-s/month the caps keep
it right at the included ceiling. Hibernation would cut that further — revisit it
with **alarm-based** bot-pacing/grace timers so it doesn't reintroduce the
per-move lag.
