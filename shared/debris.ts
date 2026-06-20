// Space junk — derelict objects drifting in orbit that you can rendezvous with
// and salvage for funds + tech. The more junk in orbit, the more there is to do:
// fly to it, match velocities, recover it. Some of it is just spent hardware;
// some of it is unmarked, and worth a lot more to whoever cracks it open.
//
// Each piece is a coasting Keplerian object (an exact function of time), so it
// costs nothing to simulate — same trick as a vessel. All current debris orbits
// Terra, so its position is already in the root inertial frame.

import { type Elements, elementsToState } from './orbit.ts'
import { type Vec2, len, sub } from './units.ts'
import { SYSTEM } from './bodies.ts'

export type DebrisKind = 'booster' | 'probe' | 'cargo' | 'mystery'

export interface DebrisDef {
  id: string
  name: string
  kind: DebrisKind
  orbit: Elements
  funds: number
  science: number
}

/** Get this close (m) and matched in velocity (m/s) to salvage. */
export const SALVAGE_RANGE = 3_000
export const SALVAGE_SPEED = 60

function terraOrbit(periAlt: number, apoAlt: number, argPe: number, M0: number): Elements {
  const b = SYSTEM['terra']
  const rp = b.radius + periAlt
  const ra = b.radius + apoAlt
  return { a: (rp + ra) / 2, e: (ra - rp) / (ra + rp), argPe, dir: 1, M0, t0: 0, mu: b.mu }
}

export const DEBRIS: DebrisDef[] = [
  { id: 'castor', name: 'Spent Booster “Castor”', kind: 'booster', funds: 4_500, science: 6, orbit: terraOrbit(340_000, 410_000, 0.4, 1.2) },
  { id: 'vesta-3', name: 'Derelict Probe Vesta-3', kind: 'probe', funds: 6_000, science: 14, orbit: terraOrbit(700_000, 900_000, 2.1, 4.0) },
  { id: 'cargo-pod', name: 'Lost Cargo Pod', kind: 'cargo', funds: 9_000, science: 10, orbit: terraOrbit(1_200_000, 1_800_000, 3.3, 0.5) },
  { id: 'upper-stage', name: 'Tumbling Upper Stage', kind: 'booster', funds: 5_200, science: 8, orbit: terraOrbit(500_000, 2_400_000, 5.0, 2.6) },
  { id: 'relay-platform', name: 'Dead Relay Platform', kind: 'cargo', funds: 7_500, science: 18, orbit: terraOrbit(600_000, 640_000, 0.0, 3.7) },
  { id: 'canister', name: 'Unmarked Canister', kind: 'mystery', funds: 14_000, science: 45, orbit: terraOrbit(2_800_000, 3_200_000, 1.0, 5.4) },
]

export const debrisDef = (id: string): DebrisDef | undefined => DEBRIS.find((d) => d.id === id)
export const debrisState = (d: DebrisDef, t: number): { pos: Vec2; vel: Vec2 } => elementsToState(d.orbit, t)

/** Within reach AND matched in velocity — a real rendezvous, not a flyby. */
export function canSalvage(d: DebrisDef, t: number, vesselPos: Vec2, vesselVel: Vec2): boolean {
  const s = debrisState(d, t)
  return len(sub(vesselPos, s.pos)) <= SALVAGE_RANGE && len(sub(vesselVel, s.vel)) <= SALVAGE_SPEED
}
