// Part catalogue — the building blocks of the Vehicle Assembly.
//
// Masses are in kg, thrust in N, Isp in seconds (specific impulse; exhaust
// velocity = Isp * g0). dragArea is a lumped Cd*A in m^2 used by the simple
// atmospheric drag model. Numbers are tuned (Kerbal-style) so a sensible
// two-stage stack reaches Terra orbit with a comfortable delta-v margin.

export type PartKind = 'pod' | 'lander' | 'tank' | 'engine' | 'decoupler' | 'fin' | 'parachute' | 'leg'

export interface PartDef {
  id: string
  name: string
  kind: PartKind
  /** Structural (dry) mass, kg. */
  dryMass: number
  /** Usable propellant mass, kg (tanks only). */
  fuel?: number
  /** Vacuum-ish thrust, N (engines only). */
  thrust?: number
  /** Specific impulse, s (engines only). */
  isp?: number
  /** Lumped drag coefficient * area, m^2. */
  dragArea: number
  /** Cost in funds. */
  cost: number
  /** Science tier required to unlock (0 = available from the start). */
  tier?: number
  /** Render hint (height in metres for the side view). */
  height: number
  color: string
}

export const PARTS: Record<string, PartDef> = {
  'cmd-pod': { id: 'cmd-pod', name: 'Command Pod Mk1', kind: 'pod', dryMass: 840, dragArea: 0.6, cost: 2_000, height: 1.2, color: '#cdd3da' },
  'lander': { id: 'lander', name: 'Lunar Lander Can', kind: 'lander', dryMass: 620, dragArea: 0.7, cost: 3_200, tier: 1, height: 1.6, color: '#d4a017' },
  'tank-small': { id: 'tank-small', name: 'Fuel Tank (Small)', kind: 'tank', dryMass: 200, fuel: 1800, dragArea: 0.4, cost: 600, height: 1.9, color: '#e0e0e0' },
  'tank-large': { id: 'tank-large', name: 'Fuel Tank (Large)', kind: 'tank', dryMass: 500, fuel: 4500, dragArea: 0.5, cost: 1_400, height: 3.8, color: '#d8d8d8' },
  'engine-vac': { id: 'engine-vac', name: 'Vacuum Engine "Apsis"', kind: 'engine', dryMass: 500, thrust: 60_000, isp: 320, dragArea: 0.3, cost: 1_100, height: 1.1, color: '#9aa0a6' },
  'engine-main': { id: 'engine-main', name: 'Main Engine "Downrange"', kind: 'engine', dryMass: 1500, thrust: 215_000, isp: 290, dragArea: 0.5, cost: 2_400, height: 1.6, color: '#7a7f85' },
  'decoupler': { id: 'decoupler', name: 'Stage Decoupler', kind: 'decoupler', dryMass: 50, dragArea: 0.1, cost: 250, height: 0.3, color: '#5a5f65' },
  'fin': { id: 'fin', name: 'Aero Fin', kind: 'fin', dryMass: 40, dragArea: 0.05, cost: 120, height: 0.8, color: '#8a8f95' },
  'parachute': { id: 'parachute', name: 'Parachute', kind: 'parachute', dryMass: 60, dragArea: 0.1, cost: 350, tier: 1, height: 0.4, color: '#c0392b' },
  'leg': { id: 'leg', name: 'Landing Leg', kind: 'leg', dryMass: 50, dragArea: 0.05, cost: 200, tier: 1, height: 0.6, color: '#8a8f95' },
}

export const part = (id: string): PartDef => {
  const p = PARTS[id]
  if (!p) throw new Error(`unknown part: ${id}`)
  return p
}
