# First Orbit

A 2D browser **multiplayer rocketry game** — build rockets, reach orbit, and run
a shared space program with your friends. Set in the *origin era* of the
**Hubble Frontier** universe: the decades before faster-than-light travel, when
humanity first claws its way to orbit and lays the keel of the Mars Orbital
Shipyards that one day build the fleet.

> *The universe is expanding. So are we.*

Think Kerbal Space Program's spirit in 2D (à la Spaceflight Simulator), with the
quality-of-life the KSP community always mods in — delta-v / TWR readouts, an
ascent autopilot, maneuver planning — shipped in the base game.

**Live:** [orbit.cpuchip.net](https://orbit.cpuchip.net)

## What works today (v0.1)

- **Real two-regime physics.** Step-integrated thrust / gravity / atmospheric drag
  during powered flight; exact analytic Keplerian orbits while coasting. The split
  is what makes deterministic, low-bandwidth multiplayer tractable — a coasting
  vessel is a function of time, not a stream of packets.
- **Vehicle Assembly readouts** — per-stage Δv and thrust-to-weight, from the
  rocket equation (the "Kerbal Engineer" mod, baked in).
- **Ascent autopilot** — a gravity-turn "fly me to orbit" button (the "MechJeb"
  mod, baked in).
- **Flight view** — auto-zooming side-on view; the home world is true-scale, so it
  fills the screen as ground on the pad and shrinks into a planet as you climb.
- **Orbital map** — Terra, Luna, your orbit, and everyone else's vessels.
- **Shared space program** — one solar system, one universe clock, a roster, and
  live chat. Persisted across redeploys.

## Stack

| Layer | Choice |
|-------|--------|
| Shared sim | Deterministic TypeScript in `shared/` — imported by client **and** server |
| Client | Vite + Svelte 5, canvas 2D renderer |
| Server | Node + `ws`, authoritative, serves the built client + same-origin `/ws` |
| Deploy | One container, `docker-compose.yml`, Dokploy auto-build on push |

## Develop

```bash
npm install --legacy-peer-deps
npm run dev:server   # the game server on :8080 (terminal 1)
npm run dev          # the Vite client on :5173, proxies /ws -> :8080 (terminal 2)
```

Open http://localhost:5173. For multiplayer, open a second tab.

## The oracles (run these before trusting anything)

```bash
npm run smoke    # deterministic physics asserts: reaches orbit, Hohmann, energy,
                 # roundtrip — AND the inverse hypothesis (a weak rocket must fail)
npm run wstest   # over-the-wire multiplayer: handshake, launch, snapshot, settle
npm run compile  # tsc --noEmit
npm run build    # vite production build (the real gate; dev hides prod-only crashes)
```

The smoke oracle is the floor under the whole simulation — if it's green the
physics still obeys the laws the game is built on. `/version` echoes the deployed
git short-sha; `curl https://orbit.cpuchip.net/version` is the deploy oracle.

## Deploy

`Dockerfile` builds the client and runs the Node server in one container. Dokploy
auto-builds `main` on push and maps `orbit.cpuchip.net` to the `game` service on
:8080. Pushing means shipping — don't push with an oracle red.

## Art

2D assets are generated with Google's Gemini image model and committed under
`public/assets/`. See [scripts/gen-assets/README.md](scripts/gen-assets/README.md).
The renderer is vector-based today, so the game runs with zero generated art; the
PNGs are the next visual pass.

## Universe

The setting is original IP — *The Hubble Frontier*, owned by the Mars-field
Science Center (Marshfield, Missouri, birthplace of Edwin Hubble). No
trademarked franchise terms. This game is the prequel: how the shipyards began.

## Roadmap

See [ROADMAP.md](ROADMAP.md). Built and stewarded by Claude (Opus) under Michael's
full delegation, oracle-first.
