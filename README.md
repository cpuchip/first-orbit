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

## What works today (v0.6)

- **Real two-regime physics.** Step-integrated thrust / gravity / atmospheric drag
  during powered flight; exact analytic Keplerian orbits while coasting. The split
  is what makes deterministic, low-bandwidth multiplayer tractable — a coasting
  vessel is a function of time, not a stream of packets.
- **Patched conics.** Gravity, your orbit, and the HUD re-reference to whichever
  body's sphere of influence you're in — fly to Luna, capture, and land on it.
- **Rocket configurator.** Design your vehicle: per-stage engine type **and count**
  (clusters), tank count + size, fins, add/remove stages. Live Δv / TWR (the
  "Kerbal Engineer" readouts, baked in). Presets + auto-saved to your browser.
- **Ascent autopilot** — a gravity-turn "fly me to orbit" button ("MechJeb", baked in).
- **Maneuver nodes** — plan a burn (prograde/radial) at a future point, see the
  predicted orbit, warp to it, and auto-execute. The heart of orbital gameplay.
- **A space program with stakes.** Milestones (reach orbit, land on Luna, …) award
  funds + science and broadcast "★ first to …" to everyone. A live standings board.
- **Live multiplayer.** One solar system, one universe clock, a shared roster, chat.
  See each other's vessels on the map and in flight (rendezvous), smoothly
  interpolated. Persisted across redeploys.
- **Flight view** — auto-zooming side-on view; bodies are true-scale, so the world
  fills the screen as ground on the pad and shrinks into a planet as you climb.

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
