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

Caps in `[vars]` (`MAX_GAMES_PER_DAY=70`, `MAX_CONCURRENT_GAMES=25`) keep usage
inside the free plan; `AdmissionDO` returns a friendly `{ t:"busy" }` before any
limit is hit. The binding free-tier limit is **SQL rows written: 100,000/day**,
shared account-wide across prod + beta (one free bucket). Measured cost ≈ 365
rows per 2-player game, ~1,015 per 4-player game — so a worst-case all-4p day
across prod (70) + beta (8) ≈ 79k rows, under the 100k cap. Rooms use **WebSocket
Hibernation** (engine persisted + rehydrated across eviction, incl. a resumable
RNG — see `room-do.js` header), so idle duration is ~zero: a full game spends
~0.5 GB-s, leaving duration far from binding. Raise the caps only on the $5
Workers Paid plan.
