# First Orbit — Claude Code project context

A 2D browser multiplayer rocketry game in the **Hubble Frontier** origin era.
Its own git repo (`github.com/cpuchip/first-orbit`), nested in the
`scripture-study` workspace at `projects/first-orbit/` and gitignored from the
parent. Built and stewarded by the agent under Michael's **full stewardship +
presidership** grant (2026-06-19) — he owns intent/vision, the agent owns the
code within it. Hands-off mandate: drive it, surface only on real input-needed.

## The shape of the thing

Two regimes, one shared deterministic core:

- **`shared/`** — the crown jewel. Pure TypeScript physics imported by BOTH the
  client and the server, so they never disagree. `units` (vec math), `bodies`
  (Terra/Luna, scaled ~1/10 like KSP), `orbit` (Kepler: state↔elements, analytic
  propagation, the whole reason MP is cheap), `physics` (RK4 thrust/gravity/drag),
  `vehicle`+`parts` (Δv/TWR from the rocket equation), `autopilot` (gravity-turn
  guidance + `simulateToOrbit`), `netproto` (wire types), `sim/smoke.ts` (oracle).
- **`server/`** — `ws` authoritative server (`index.ts`) over a shared persistent
  `Program` (`program.ts`); serves `dist/` + same-origin `/ws` + `/healthz` +
  `/version`. `wstest.ts` is the over-the-wire oracle.
- **`src/`** — Svelte 5 client. `App.svelte` (screens + loop + HUD), `game.ts`
  (client flight driver + on-rails warp + server sync), `render.ts` (canvas: flight
  + map), `net.ts` (ws client).
- **`scripts/gen-assets/`** — Gemini ("Nano Banana") asset pipeline. `.env` holds
  `GEMINI_API_KEY` (free AI Studio tier). Hero art via the Google AI Pro app/Whisk.

## The discipline (this is the project's spine)

1. **Build the oracle first.** Any new sim capability gets an assertion in
   `shared/sim/smoke.ts` (or `server/wstest.ts`) BEFORE the feature. The oracle is
   the deterministic floor that makes autonomous iteration safe.
2. **Inverse hypothesis.** The smoke oracle includes a deliberately-weak rocket
   that MUST fail to orbit — a test that can't fail proves nothing. Keep that
   discipline for every new assertion.
3. **The published artifact is the test.** `npm run build` (not just dev), then
   verify in a real browser via the `playwright-cli` skill. Dev hides prod-only
   crashes (the cpuchip.net `Buffer`/`glob` lesson).
4. **`/version` is the deploy oracle.** `curl orbit.cpuchip.net/version` must equal
   the pushed git short-sha before a deploy is "done."

## Gates (run before every commit)

```bash
npm run smoke && npm run wstest && npm run compile && npm run build
```

Green all four, then commit. Don't push with an oracle red — pushing `main`
auto-deploys via Dokploy (orbit.cpuchip.net → `game` service :8080).

## Conventions

- **`.npmrc` sets `legacy-peer-deps=true`** (same stale-peer gotcha as the other
  Vite projects here). Use `npm ci --legacy-peer-deps`.
- **Units are SI** (m, s, kg, N). Bodies are scaled ~1/10 for playability; the
  maths is real. Frame: Terra-centred inertial, Terra at origin (stationary).
- **Determinism matters.** `shared/` must stay pure and side-effect-free — no
  `Date.now()`, no randomness in the sim path (the starfield in `render.ts` is the
  only `Math.random`, and it's cosmetic/client-only).
- Don't commit `data/` (runtime state), `.env`, `dist/`, `node_modules/`.

## Stewardship & working-session protocol

At the end of every working session on this repo: run the four gates, commit with
a clear *why*, push when the slice is verified. Background-verify a live deploy
with `/version`. Keep `ROADMAP.md` current — it's the record of the drive. The
workspace journal/memory for this project lives under the parent's
`.spec/journal/` and memory (`project_first_orbit_game`).
