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
(`docs/multiplayer-plan.md` → "the DO is a thin transport + state shell").

## Local dev / tests — unchanged

CF is **not** used for dev or CI. `npm run dev` and the Playwright e2e suite run
`server/local-server.mjs` (Node `ws`) on port 8890 — same engine, same protocol.
The client only dials Cloudflare on a non-localhost host (see
`scripts/net-client.js` → `resolveServerUrl`).

Run the Worker locally against Miniflare/workerd:

```bash
npm run cf:dev        # wrangler dev — local DO emulation on http://localhost:8787
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
`.github/workflows/release-web.yml`.

## Point the client at it

`scripts/net-client.js` defaults production to `wss://mp.leludo.org`. Two ways to
make that resolve:

1. **Custom domain (recommended).** Add `leludo.org`'s DNS to Cloudflare, then
   uncomment the `[[routes]]` block in `wrangler.toml` and redeploy — wrangler
   creates the `mp` record.
2. **`*.workers.dev` meanwhile.** After the first deploy, override per-browser:
   `localStorage.setItem('leludo-mp-server', 'wss://leludo-mp.<subdomain>.workers.dev')`,
   or append `?server=wss://…` to the URL for a one-off test.

## Free-tier safety

Caps in `[vars]` (`MAX_GAMES_PER_DAY=45`, `MAX_CONCURRENT_GAMES=15`) keep usage
inside the free plan; `AdmissionDO` returns a friendly `{ t:"busy" }` before any
limit is hit. The binding free-tier limit is **SQL rows written: 100,000/day**,
shared account-wide across prod + beta (one free bucket).

`LudoRoomDO` is **resident, not hibernated** (see `room-do.js` header). The
WebSocket-hibernation experiment (v0.24.5) wrote a full engine snapshot to DO
storage on **every** broadcast so state could survive eviction — the dominant
per-game source of rows-written (≈570 rows/2p, ~1,668/4p in live data) **and** a
source of per-move lag (CF's output gate held each roll/move frame until the
write landed, plus a cold wake on the first move after think-time). Reverting to
resident sockets removes the per-broadcast persist entirely: a game now writes
only the admission admit/release counters + the occasional leak-guard alarm — a
handful of rows, not hundreds — so the rows cap is far harder to approach.

The trade is duration (GB-s): a resident DO stays in memory through human
think-time. That was never the binding limit on free (13,000 GB-s/day) and isn't
billed there, so it's safe. Revisit hibernation only on the paid plan, where
GB-s bills — and then with a **non-gating async persist** (broadcast first,
persist after) and/or **alarm-based** bot-pacing/grace timers so it doesn't
reintroduce the lag (see `docs/multiplayer-plan.md`). Raise the caps only on the
$5 Workers Paid plan.
