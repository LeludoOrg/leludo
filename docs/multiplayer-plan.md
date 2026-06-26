# Multiplayer Plan — Cloudflare Durable Objects

Status: **deploy shell implemented**. Branch: `feat/multiplayer-plan`. The
runtime-agnostic engine (`server/room-engine.js`, `server/admission.js`,
`server/matchmaker.js`) shipped first behind a local Node `ws` runtime; that Node
shell has since been retired — dev + e2e now run the real Cloudflare Worker under
`wrangler dev` (local workerd) so they match the deployed DO semantics exactly.
The Cloudflare transport shell lives in
[`server/cf/`](../server/cf/) (Worker + three Durable Objects) with
[`wrangler.toml`](../wrangler.toml) and a `deploy-worker` job in
[release.yml](../.github/workflows/release.yml) (prod) / `deploy-worker-beta`
in [release-beta.yml](../.github/workflows/release-beta.yml). See
[server/cf/README.md](../server/cf/README.md) for the deploy runbook.

**Hibernation was reverted (it cost latency, not just GB-s).** `LudoRoomDO` is
now **resident** again (`server.accept()`, no per-broadcast snapshot). The
section below is kept for the history + the paid-plan plan, but hibernation is
**off** in prod. Why it was pulled: surviving eviction required persisting the
engine to storage on **every** broadcast, and CF's output gate then held each
roll/move frame until that write landed (visible per-action lag), plus a cold
wake on the first move after a player's think-time. On the **free** plan the
binding limit is **rows-written, not duration**, so those persist writes were
inflating the *binding* cost while only saving the *non-binding* one — a net
loss on top of the lag. Resident sockets respond instantly and write ~no
per-game rows. **Revisit only on a paid plan**, and then with a *non-gating*
async persist (broadcast first, persist after) + alarm-based bot/grace timers so
the lag doesn't come back.

---

**[HISTORY — superseded by the revert above] Hibernation landed, but bot games
pin the DO.** v0.24.5 added WebSocket
Hibernation: the engine serialises + rehydrates across eviction (resumable RNG
included), and idle keepalive pings are answered by `setWebSocketAutoResponse`
without waking the DO. A clean, idle, **human-only** game now hibernates between
moves and burns ~zero duration — measured **~0.4 GB-s for a full 2-player game**.

The catch: the engine's bot-pacing (`schedule`) and reconnect-grace (`setTimer`)
still default to plain `setTimeout`, and `LudoRoomDO._engineOpts` does **not**
inject alarm-based versions. A pending `setTimeout` blocks eviction, so any game
with a **bot** (a next-turn timer is almost always pending) or an active
**disconnect-grace window** stays resident for its whole wall-clock — measured
**~13 GB-s for a 2-human + 2-bot game** (≈34× the clean 2p game). Most real games
fill empty seats with bots, so hibernation's savings are largely unrealised in
practice. A zero-connection leak-guard alarm covers the one case pinning misses
(every client drops at once → DO evicted → grace timers lost).

This does **not** threaten the free tier: even at ~13–110 GB-s/game the duration
ceiling (13,000 GB-s/day) is only hit after ~120–1,000 games/day, while **SQL
rows written (100k/day) binds first at ~60–175 games/day** (see Budget). So caps
are sized on rows, not duration.

**TODO — revisit on a paid plan.** On the paid plan duration is *billed*, not
throttled, and bot games make it the fastest-filling bucket: ~400k GB-s/month
included ÷ ~13 GB-s ≈ **31k games** (or ÷110 for long games ≈ 3.6k), vs ~730k if
they hibernated. If/when we move to paid, evaluate converting bot-pacing + grace
`setTimeout` → DO alarms (or just accepting the cost). For **bots** the duration
is largely *inherent active compute* (the DO genuinely runs AI every ~600ms), so
the realistic reclaim is the **grace** window (a 60s pin per disconnect). Overage
is cheap (~$0.00016/game) — likely not worth the complexity until volume is real.

**Public matchmaking is deployed but not wired client-side.** The launch client
is private-rooms-only; `MatchmakingDO` exists for parity. Turning it on needs a
client redial (a queued socket can't be moved between DOs — see
[match-do.js](../server/cf/match-do.js) header).

## Goal

Add online multiplayer (humans across devices) to Leludo without trusting the
client and without risking a surprise bill. Single-player stays 100% client-side
and unchanged.

Two hard requirements drive the design:

1. **Server-authoritative** — dice rolls, move legality, turn order, captures,
   and end-game are decided on the server. The client sends *intents* and
   renders *broadcasts*. A cheater editing local state cannot change the game.
2. **Hard capacity cap** — operator-set limits on concurrent games and games
   per day. When a limit is hit, the player is told **"server busy, come back
   later"** — an explicit, friendly rejection. Never a silent failure, never
   going over the free-tier budget into paid overage.

## Why Cloudflare Durable Objects (DO)

- A DO is a **stateful** server object: one instance = one game room, holding
  board state in memory and owning the players' WebSocket connections. This is
  exactly the shape of an authoritative game room (stateless functions on
  Firebase/Supabase are the wrong shape — cold start + DB round-trip per move).
- **Free plan includes SQLite-backed DOs.** Limits (as of this writing):
  - Requests: 100,000 / day
  - Duration: 13,000 GB-s / day
  - SQLite: 5 GB store, 5M reads/day, 100k writes/day
- **Structurally unspendable on the free plan** — hitting a limit throttles,
  it does not bill. We add our own cap *below* the free limit so we reject
  gracefully before CF throttles us.
- WebSocket **hibernation** → idle turn-based game between moves burns ~zero
  duration and never disconnects.
- No egress/bandwidth fees at any tier (the usual WebSocket cost-killer is
  absent).

Pricing / limits references:
- https://developers.cloudflare.com/durable-objects/platform/pricing/
- https://developers.cloudflare.com/durable-objects/platform/limits/
- https://developers.cloudflare.com/workers/platform/pricing/

## Reuse of existing pure modules — the big win

The game's rules already live in **DOM-free, side-effect-free** modules. They
import unchanged into a DO (it's just JS, no browser APIs):

| Module | What the DO uses it for |
|---|---|
| [`scripts/game-logic.js`](../scripts/game-logic.js) | `generateDiceRoll(rng)`, `isTokenMovable`, `getTokenNewPosition`, `findCapturedOpponents`, `isTripComplete`, `isSafePosition`, `SAFE_SQUARES` |
| [`scripts/turn-rules.js`](../scripts/turn-rules.js) | `getNextPlayerIndex`, `isPlayerFinished`, `shouldEndGame`, `computeLeftoverRankOrder`, `serializeGameState`/`deserializeGameState` |
| [`scripts/bot-ai.js`](../scripts/bot-ai.js) | `pickBestMove`, `PERSONALITIES` — server-side bots to fill empty seats (also uncheatable) |
| [`scripts/game-driver.js`](../scripts/game-driver.js) | **Reference template.** `runGame` is the full authoritative loop. The DO is an *interactive* version of the same loop: instead of one synchronous `while`, it pauses at each human decision and waits for an intent message. |

The DO's turn handler is a faithful split of `runGame`'s loop body:
roll → check three-sixes → list movable → (human picks / bot `pickBestMove`) →
`applyMove` → captures → finish/rank → `playsAgain?` → `getNextPlayerIndex`.

**Architectural rule:** the DO is a *thin transport + state shell*. All rules
stay in the pure modules. This keeps the CF-specific surface small and makes a
future migration (to Colyseus on a VM, etc.) a shell rewrite only.

## Components

```
client (wc-board, multiplayer mode)
   │  wss://  (intents up, state broadcasts down)
   ▼
Worker (router)
   ├─► AdmissionDO     (singleton)  ── capacity gate + counters
   ├─► MatchmakingDO   (singleton)  ── public queue (random match)
   └─► LudoRoomDO      (one per game) ── authoritative game state
```

### 1. Worker (router / entry)

- Terminates `wss://`, routes `/admit` and `/room/:id` to the right DO.
- Free TLS + WebSocket upgrade handled by CF.
- Holds **no game state** — pure router.

### 2. AdmissionDO (singleton — the hard-limit gate)

A single global DO (fixed name, e.g. `idFromName("admission")`) is the **only**
place that authorizes a new game. This is the feature the operator asked for.

State:

```
activeGames        // currently-running rooms
gamesStartedToday  // resets at UTC midnight via DO alarm
```

Config (via Worker env vars — operator-tunable, no redeploy of logic).
**Values are sized to stay inside the Workers Paid plan's INCLUDED allowance**
(no overage; see Budget). Only prod is scaled up; beta keeps a small slice
(25/day, 5 concurrent):

```
MAX_CONCURRENT_GAMES = 250   // simultaneous rooms (soft-realtime guard)
MAX_GAMES_PER_DAY    = 1000  // new games / UTC day — right at the 50M-rows-written/month included ceiling
RECONNECT_GRACE_MS   = 60000 // disconnect grace before forfeit
MATCH_FILL_MS        = 20000 // public-queue wait before bot-fill
```

Flow:

- **Create-game request →** AdmissionDO checks both caps:
  - `activeGames >= MAX_CONCURRENT_GAMES` → reply `{ ok:false, reason:"BUSY_CONCURRENT" }`
  - `gamesStartedToday >= MAX_GAMES_PER_DAY` → reply `{ ok:false, reason:"BUSY_DAILY" }`
  - else: `activeGames++`, `gamesStartedToday++`, mint a room id, reply `{ ok:true, roomId }`.
- **Room ends / all players gone →** RoomDO calls back `release(roomId)` →
  `activeGames--`. Idempotent (a room releases at most once).
- **Daily reset →** DO alarm set to next UTC midnight; on fire,
  `gamesStartedToday = 0` and re-arm. (Alarm fires count as requests but are
  trivial — one per day.)
- **Crash-safety / leak guard:** `activeGames` is also reconciled — each room
  writes a heartbeat/last-seen; AdmissionDO sweeps stale rooms on alarm so a
  crashed room can't permanently consume a slot. Counter persisted to DO
  storage so it survives hibernation/eviction.

Cost of the gate itself: **2 requests per game** (admit + release) + 1
alarm/day. Negligible against the budget.

Admission is **mode-agnostic** — both private (room-code) and public
(matchmade) games call `admit` before a room opens, so the caps protect every
path. A public match counts as one game (not per-player).

**Why a hard cap below the free limit?** The free plan throttles at its daily
limits — the binding one is **100k SQL rows written/day**, shared account-wide
across prod + beta — but a throttle is an ugly mid-game failure. By capping games
*ourselves* (45/day prod + 5/day beta ≈ 83k rows worst-case all-4p, under 100k)
we (a) reject new games cleanly at the lobby with a friendly message, (b) never
let an in-progress game die from a throttle, (c) guarantee we never tip into paid
overage.

### 2b. MatchmakingDO (singleton — public queue)

Handles **public** games (random matchmaking). Private games skip this entirely
(see below).

State:

```
queue   // waiting players: { sessionId, name, joinedAt, ws }
```

Flow:

- Player picks **"Play online → Public"** → joins `queue`.
- When enough players are waiting (2 minimum; up to 4), MatchmakingDO calls
  `AdmissionDO.admit` for the batch:
  - `ok` → mints a `LudoRoomDO`, moves the matched players in, clears them from
    the queue.
  - `BUSY` → keep players queued, show "servers busy, still searching…" (the cap
    is respected even for matchmaking — no overflow).
- **Fill timeout:** if a player waits past `MATCH_FILL_MS` (e.g. 20s) without a
  full table, offer "start now" → fill remaining seats with **bots** server-side
  (`pickBestMove`), then admit. Player never stuck forever.
- **Leave queue** on disconnect or cancel.

Cost: queue ops are cheap; one `admit` per formed match (already counted).

### Matchmaking — public vs private

| | Private (room code) | Public (matchmade) |
|---|---|---|
| Entry | "Create / Join with code" | "Play online → Public" |
| Routing | code ↔ `roomId` (`idFromName(code)`) | MatchmakingDO assigns room |
| Who joins | only people with the code | strangers from the queue |
| Cap path | `admit` on create | `admit` on match-form |
| Empty seats | host chooses: wait, or fill bots | auto-fill bots after `MATCH_FILL_MS` |

**Private rooms:** "Create" → client picks/derives a short code → `admit` → open
`LudoRoomDO` named from the code → share code. "Join" → look up the code's room,
seat the player. Unknown/expired code → friendly "room not found." Codes are
short, human-shareable (e.g. 4–6 chars), collision-checked at create.

### 3. LudoRoomDO (one per game — authoritative state)

State held in memory (persisted to SQLite sparingly — see Budget):

```
roomId, createdAt, lastActiveAt
playerTypes[]            // PLAYER | BOT | undefined
playerNames[], botPersonalities[]
playerTokenPositions[][] // the board — server's single source of truth
currentPlayerIndex, currentDiceRoll, consecutiveSixesCount
playerCaptures[], playerRanks[], playerTimes[], lastRank
seed / rng state         // server-side dice RNG (mulberry32, makeRng)
connections              // playerIndex → hibernatable WebSocket
phase                    // LOBBY | AWAIT_ROLL | AWAIT_MOVE | ENDED
```

Handlers (all validate against server state, reject illegal input):

- `join` — seat assignment, lobby fill, start when ready (empty seats → bots).
- `roll` — only if `phase==AWAIT_ROLL` **and** sender == `currentPlayerIndex`.
  Server calls `generateDiceRoll(rng)` (RNG lives here — client never rolls).
  Handles three-sixes, no-movable-token → advance turn. Broadcasts
  `{ dice, legalMoves }`.
- `move tokenIndex` — only if `phase==AWAIT_MOVE`, sender == current player, and
  `tokenIndex ∈ legalMoves`. Applies via `getTokenNewPosition` +
  `findCapturedOpponents`; updates ranks/end-game via turn-rules. Broadcasts new
  state (delta preferred).
- **Forced-move optimization:** if exactly one legal move, server auto-applies
  it after the roll — no second client message (saves requests, see Budget).
- **Bot turns:** run `pickBestMove` server-side, scheduled via DO alarm with a
  small delay for natural pacing (mirrors the `scheduleTurn`/pause model).
- `disconnect` — **pause-and-wait, then forfeit** (see below); on
  all-human-gone or game-end, call `AdmissionDO.release(roomId)`.

## Disconnect handling — pause-and-wait, then forfeit

When a human player's socket drops:

1. **Pause** the game immediately. Mirrors the existing pause model — set a
   `paused` phase, stop the turn flow, broadcast `{ t:"paused", waitingFor }`.
   Remaining players see *"Waiting for <name> to reconnect…"* with a countdown.
2. **Grace timer** — DO alarm armed for `RECONNECT_GRACE_MS` (e.g. 60s). If the
   player reconnects to the same room within the window → replay `state`
   snapshot, clear pause, resume. (Reconnect keyed by a per-session token so a
   refresh re-seats the same player.)
3. **Forfeit** — if the grace timer fires with the player still gone:
   - That player is ranked last among the unfinished (a forfeit), OR their seat
     is handed to a server-side bot to keep the table playable for the
     remaining humans — **operator choice, default = forfeit** (rank last, fold
     their tokens). Bot-substitute is the alternative if we'd rather not shrink
     the table.
   - Broadcast `{ t:"forfeit", player }`, then continue or end via the normal
     `shouldEndGame` / `computeLeftoverRankOrder` path.
4. If **all** humans are gone, end the room and `release(roomId)` — never leave a
   paused room holding a capacity slot. (The stale-room sweep in AdmissionDO is
   the backstop if even this is missed.)

Config: `RECONNECT_GRACE_MS` (default 60s), `FORFEIT_MODE` = `rank-last` |
`bot-substitute` (default `rank-last`).

## Wire protocol (minimal payloads — operator controls the format)

Optimized because it's our game. Compact, delta-based.

Client → server (intents only, tiny):

```
{ t:"join", room, name }
{ t:"roll" }
{ t:"move", token: 0..3 }
```

Server → client (broadcasts; outgoing = not billed as requests):

```
{ t:"state", ... }        // full snapshot on join/reconnect
{ t:"dice", v, legal:[…]} // roll result + legal token choices
{ t:"moved", p, token, from, to, caps:[…] }   // delta
{ t:"turn", p }           // whose turn
{ t:"paused", waitingFor, ms }   // a player dropped; grace countdown
{ t:"forfeit", p }        // grace expired, player folded
{ t:"ended", ranks:[…] }
{ t:"busy", reason }      // capacity rejection (see below)
```

Public-queue intents:

```
{ t:"queue" }             // join public matchmaking
{ t:"queue_cancel" }
{ t:"create" }            // private room → server returns { t:"code", code }
{ t:"join", code, name }  // private room by code
```

## "Server busy" UX (explicit, not silent)

When AdmissionDO rejects:

1. Client `POST /admit` (or first WS frame) gets `{ ok:false, reason }`.
2. `wc-board` / quick-start shows a friendly overlay:
   *"Servers are busy right now — please try again in a few minutes."*
   (Reuse `.frame-overlay` shell, same as pause/settings.)
3. No room is opened, no WebSocket left dangling. The single-player option stays
   offered as a fallback CTA ("Play vs bots instead").

Distinct copy per reason is optional (`BUSY_CONCURRENT` vs `BUSY_DAILY`) but the
user-facing message can be one friendly string.

## Budget model (how the caps are chosen)

Billing facts that matter:
- **Request** = each *incoming* WS message + initial connect. Outgoing
  broadcasts are free.
- **Duration** billed only while the DO runs JS; hibernation = idle is free.
- **SQLite writes** only if we persist.

Per optimized 4-player game (~200 rolls, forced-moves auto-applied,
no app-level pings):
- ~300 incoming requests / game.
- ~0.4 GB-s duration / game.
- State kept in DO memory; persist to SQLite only on checkpoint/disconnect →
  writes negligible.

Free-tier ceilings vs per-game cost:

| Limit | Budget/day | Per game | Games/day |
|---|---|---|---|
| Requests | 100,000 | ~300 | **~330** ← binding |
| Duration | 13,000 GB-s | ~0.4 | ~32,000 |
| SQLite writes | 100,000 | ~0 (memory-first) | huge |

**Launch caps stay inside the free tier — by design.** With `MAX_GAMES_PER_DAY
= 250`:

| Free-tier limit | Budget/day | 250 games cost | Headroom |
|---|---|---|---|
| Requests | 100,000 | ~75,000 (250 × ~300) | ~25% spare for admission/queue/reconnect overhead |
| Duration | 13,000 GB-s | ~100 GB-s (250 × 0.4) | ~99% spare |
| SQLite writes | 100,000 | ~few k (memory-first) | huge |

250 is deliberately **below** the ~330-game request ceiling so admission gating,
matchmaking, and reconnects fit in the remaining ~25k requests without ever
touching the throttle. `MAX_CONCURRENT_GAMES = 250` is a soft-realtime guard
(memory/connection sanity), not the binding limit — daily total is. The moment
a player would push past either cap, AdmissionDO returns `busy` (friendly
overlay) rather than spending into a throttle or paid overage. **Result: the
operator cannot accidentally exceed the free plan at launch values.**

**Anti-footgun rules (must-haves):**
- **No app-level heartbeats/pings** — rely on hibernation + CF keepalive. App
  pings would silently burn the request budget.
- Debounce reconnect storms (one cheater reload loop must not spend the budget).
- Keep state in memory; persist sparingly.
- **Now on the $5 Workers Paid plan** (no hard spend cap by default): the
  AdmissionDO caps are kept (raised to the paid INCLUDED allowance — prod
  1000/day ≈ 50M rows + ~390k GB-s per month, right at the included ceiling;
  beta stays a small 25/day slice) AND a Cloudflare
  **billing alert** is the backstop. The caps are the real protection; the alert
  catches anything that slips past.

## Identity — anonymous by default, optional lightweight account

Support **both**, layered so anonymous is the zero-friction default and accounts
are an opt-in upgrade. No mandatory login ever blocks "press play."

**Tier 1 — anonymous session (default, everyone):**
- On first connect the server issues a `sessionId` (random token), stored in the
  client's `localStorage`.
- It's the reconnect key (refresh/drop → same seat) and the per-game player
  identity. No PII, no signup.
- Sufficient for all of public + private play. This is what launch ships on.

**Tier 2 — lightweight account (opt-in, enables history/leaderboards):**
- Player can "claim" a handle — minimal credential (e.g. email magic-link or
  device-bound key; no passwords). Anonymous session upgrades in place, keeping
  their `sessionId`.
- Backed by **SQLite in a dedicated DO** (cheap: 5 GB free store). Tables:
  `players(id, handle, createdAt)`, `matches(id, endedAt, ranks…)`,
  `results(matchId, playerId, rank, captures)`.
- Unlocks: match history, win/loss record, leaderboards — all as plain SQL
  queries, no extra infra. Writes only at game-end (once per match) → negligible
  against the 100k writes/day budget.

**Build order:** ship Tier 1 with multiplayer; add Tier 2 later as a pure
addition (no protocol change — accounts ride on the same `sessionId`). The DO
shell stays unaware of identity tier; it just trusts the `sessionId` the Worker
attaches after auth.

## Client changes (kept thin)

- New `multiplayer` mode in `wc-board`: in this mode, **do not** call
  `game-logic` to mutate state. Send intents over WS, render from broadcasts.
- Single-player path unchanged (still fully client-side).
- New tiny WS client module (e.g. `scripts/net-client.js`) — connect, send
  intent, dispatch incoming broadcasts into the existing render path.
- Reconnect: on socket drop, reconnect to same room, server replays `state`
  snapshot.
- Busy overlay (above).

## Testing

Follow the repo's bug-fix discipline (every behaviour gets a test):

- **Pure logic** already covered by existing vitest + `game-driver` integration
  tests — no change to rules means those keep passing.
- **DO logic** — unit-test the room handler with a fake WebSocket + injected
  seeded `makeRng`, asserting: illegal move rejected, out-of-turn roll rejected,
  client-forged position ignored, three-sixes, capture, end-game ranks.
- **AdmissionDO** — test caps: Nth+1 concurrent game → `BUSY_CONCURRENT`;
  daily cap → `BUSY_DAILY`; release decrements; alarm resets daily counter;
  stale-room sweep frees leaked slots.
- **E2E (Playwright)** — two browser contexts join one room, play a few turns,
  assert both see identical server-driven state; a third context past the cap
  sees the busy overlay.
- Cloudflare `workerd` / Miniflare local runtime for DO tests in CI.

## Rollout phases

1. **Spike** — bare Worker + RoomDO, two manual WS clients, server dice + one
   move validated end-to-end. Prove authority.
2. **Admission gate** — AdmissionDO + caps + busy overlay. Prove we reject
   cleanly and never silently fail.
3. **Full turn flow** — port the whole `runGame` loop body into the room
   (three-sixes, captures, finish/rank, play-again, bot fill).
4. **Client multiplayer mode** — `net-client.js`, `wc-board` mode switch,
   reconnect, lobby/room-code UX.
5. **Hardening** — disconnect handling, stale-room sweep, persistence on
   checkpoint, billing alert (if paid), load test against caps.
6. **Ship** — behind a feature flag; single-player untouched throughout.

## Decisions locked

- **Matchmaking: both.** Private room-codes (play with friends) **and** public
  random matchmaking (queue). See the Matchmaking section.
- **Disconnect: pause-and-wait, then forfeit.** Pause on drop, `RECONNECT_GRACE_MS`
  grace window, forfeit (rank-last) on expiry. See Disconnect Handling.
- **Caps sized to the Workers Paid plan's included allowance.**
  `MAX_GAMES_PER_DAY = 1000` (prod) / `25` (beta),
  `MAX_CONCURRENT_GAMES = 250` (prod) / `5` (beta),
  `RECONNECT_GRACE_MS = 60s`, `MATCH_FILL_MS = 20s` — prod ≈ 50M rows-written
  + ~390k GB-s per month, right at the paid INCLUDED ceiling; beta's 25/day
  slice tips it a touch over → minor metered overage (~$1-2/mo), caught by the
  billing alert. Live values; see `wrangler.toml`. (Earlier free-tier launch values
  were 45/15; the Budget table above predates the measured rows-written cost.)
- **Identity: both, layered.** Anonymous session by default (Tier 1, ships at
  launch); optional lightweight account (Tier 2, SQLite-backed) added later for
  history/leaderboards. See Identity section.

## Open decisions (none blocking build)

- `FORFEIT_MODE` default: `rank-last` (shrink table) vs `bot-substitute` (keep
  table full). Plan defaults to `rank-last` — revisit after playtest.
- Tier 2 account credential: email magic-link vs device-bound key — decide when
  building accounts, not needed for launch.
