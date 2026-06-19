# First Orbit — roadmap

The drive from a proven core to a game friends play. Each version is a tested
commit+push; the oracles (`smoke`, `wstest`, `compile`, `build`) gate every step.
This mirrors how the deadweight game was driven to parity — small, verified,
deployable increments.

## v0.1 — Foundation ✅ (2026-06-19)
Deterministic two-regime sim, VAB Δv/TWR, ascent autopilot, flight + map views,
authoritative `ws` server + shared persistent program + chat, Dokploy compose,
Gemini asset pipeline. Both oracles green; live at orbit.cpuchip.net.

## v0.2 — Patched conics & Luna ✅ (2026-06-19)
SOI re-referencing (dominantBody/referenceFrame), fly + capture + land on Luna,
true-scale bodies in the flight view. Oracle: SOI selection, frame continuity,
bound low-Luna orbit.

## v0.3 — The Assembly (configurator) ✅ (2026-06-19)
Per-stage engine type + count (clusters), tanks/size, fins, add/remove stages,
live Δv/TWR, presets, localStorage persistence. *(Still wanted: full drag-drop
attach + generated part-icon art from `gen-assets`.)*

## v0.4 — Maneuver nodes ✅ (2026-06-19)
Plan Δv (prograde/radial) at a future point, dashed predicted orbit, warp-to-node,
auto-execute. Oracle: circularization node → circular orbit; zero node = no-op.
*(Still wanted: porkchop transfer-window hinting.)*

## v0.5 — Economy & live multiplayer ✅ (2026-06-19)
Milestones → funds/science + "★ first to…" broadcasts + recovery; standings
board; other players visible on the map AND in flight (rendezvous) with eased
interpolation. *(Still wanted: shared tech tree, synchronous co-flight.)*

## v0.6 — Mars & the shipyards (NEXT)
- Add Sol + Mars; the campaign arc ends by reaching Mars orbit and placing the
  first shipyard module — the literal origin of "Mars-field built."
- Science from biomes/altitudes; the progression loop.
- Server-side saved designs; part-icon art; sound.

## Later
- More bodies, aerobraking, rover/EVA, re-entry heating, sounds, mobile controls.
- Hero art via Whisk; visual pass replacing vector placeholders with sprites.

## Discipline (non-negotiable)
- Build/extend the **oracle first** for any new sim capability, then implement.
- Every claimed fix runs the inverse hypothesis (reproduce the failure, fix,
  confirm gone). "Build passed" is not verification.
- `curl orbit.cpuchip.net/version` == pushed short-sha before calling a deploy done.
