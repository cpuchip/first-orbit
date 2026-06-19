# First Orbit — roadmap

The drive from a proven core to a game friends play. Each version is a tested
commit+push; the oracles (`smoke`, `wstest`, `compile`, `build`) gate every step.
This mirrors how the deadweight game was driven to parity — small, verified,
deployable increments.

## v0.1 — Foundation ✅ (2026-06-19)
Deterministic two-regime sim (powered physics + analytic Kepler), VAB Δv/TWR
readouts, ascent autopilot, flight + map views, authoritative `ws` server with a
shared persistent program + chat, Dockerfile/compose for Dokploy, the Gemini asset
pipeline. Both oracles green; full loop browser-verified.

## v0.2 — Land & return
- Patched conics across Luna's sphere of influence (transfer, capture, the map
  re-references to Luna inside its SOI).
- Touchdown detection + landed state; parachutes that bite in atmosphere.
- Recover-for-funds; a first contract ("reach orbit", "land on Luna").
- Oracle: a scripted Terra→Luna transfer that captures and lands.

## v0.3 — The Assembly
- Real drag-drop 2D vehicle assembly: stack/attach parts, set staging order.
- The part catalogue surfaced as a parts bin; save/load designs per player.
- Generated part-icon art (the `gen-assets` set) wired into the VAB.

## v0.4 — Maneuver nodes & planning
- Plan a burn on the map (the maneuver node), see the resulting orbit, and a
  node executor + "warp to node" (the Kerbal Alarm Clock / MechJeb node features).
- Transfer-window hinting toward Luna/Mars (porkchop-lite).

## v0.5 — Multiplayer presence, live
- Smooth interpolation of other players' active flights (not just coasting).
- Per-player funds/science economy; a shared tech tree that unlocks parts.
- Synchronous co-flight in the same region (subspace time-warp reconciliation).

## v0.6 — Mars & the shipyards
- Add Sol + Mars; the campaign arc ends by reaching Mars orbit and placing the
  first shipyard module — the literal origin of "Mars-field built."
- Science from biomes/altitudes; the progression loop.

## Later
- More bodies, aerobraking, rover/EVA, re-entry heating, sounds, mobile controls.
- Hero art via Whisk; visual pass replacing vector placeholders with sprites.

## Discipline (non-negotiable)
- Build/extend the **oracle first** for any new sim capability, then implement.
- Every claimed fix runs the inverse hypothesis (reproduce the failure, fix,
  confirm gone). "Build passed" is not verification.
- `curl orbit.cpuchip.net/version` == pushed short-sha before calling a deploy done.
