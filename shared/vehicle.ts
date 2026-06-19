// Vehicle assembly & performance maths.
//
// A vehicle is an ordered list of STAGES, fired bottom-up (stage 0 is the launch
// stage). Each stage is a set of parts. We derive what the editor shows — total
// mass, per-stage delta-v and thrust-to-weight — straight from the catalogue, so
// the "Kerbal Engineer" readouts are part of the base game, not a mod.

import { G0 } from './units.ts'
import { part, type PartDef } from './parts.ts'

export interface Stage {
  /** Part ids in this stage (engines, tanks, structure). */
  partIds: string[]
}

export interface Vehicle {
  name: string
  /** Bottom-up firing order: stages[0] lights first and is dropped first. */
  stages: Stage[]
}

export interface StagePerf {
  index: number
  thrust: number // N (sum of this stage's engines)
  isp: number // s (thrust-weighted average)
  fuel: number // kg in this stage
  massStart: number // kg at ignition (this stage + everything above)
  massEnd: number // kg at burnout
  deltaV: number // m/s
  /** TWR at ignition against a reference surface gravity. */
  twr: (surfaceG: number) => number
}

const stageDryMass = (s: Stage): number => s.partIds.reduce((m, id) => m + part(id).dryMass, 0)
const stageFuel = (s: Stage): number => s.partIds.reduce((m, id) => m + (part(id).fuel ?? 0), 0)
const engines = (s: Stage): PartDef[] => s.partIds.map(part).filter((p) => p.kind === 'engine')

export function stageThrust(s: Stage): number {
  return engines(s).reduce((t, e) => t + (e.thrust ?? 0), 0)
}

/** Thrust-weighted average Isp of a stage's engines (0 if no engines). */
export function stageIsp(s: Stage): number {
  const es = engines(s)
  const tot = es.reduce((t, e) => t + (e.thrust ?? 0), 0)
  if (tot === 0) return 0
  return es.reduce((acc, e) => acc + (e.isp ?? 0) * (e.thrust ?? 0), 0) / tot
}

/** Total wet mass of the whole vehicle, kg. */
export function totalMass(v: Vehicle): number {
  return v.stages.reduce((m, s) => m + stageDryMass(s) + stageFuel(s), 0)
}

/** Lumped drag area (Cd*A) of the whole vehicle, m^2. */
export function totalDragArea(v: Vehicle): number {
  return v.stages.reduce((d, s) => d + s.partIds.reduce((a, id) => a + part(id).dragArea, 0), 0)
}

/** Per-stage performance, computed with the rocket equation. */
export function performance(v: Vehicle): StagePerf[] {
  const out: StagePerf[] = []
  // Mass above stage i = dry+fuel of all stages strictly above i.
  for (let i = 0; i < v.stages.length; i++) {
    const s = v.stages[i]
    const massAbove = v.stages
      .slice(i + 1)
      .reduce((m, up) => m + stageDryMass(up) + stageFuel(up), 0)
    const dry = stageDryMass(s)
    const fuel = stageFuel(s)
    const massStart = massAbove + dry + fuel
    const massEnd = massAbove + dry
    const isp = stageIsp(s)
    const thrust = stageThrust(s)
    const ve = isp * G0
    const deltaV = ve > 0 && massEnd > 0 ? ve * Math.log(massStart / massEnd) : 0
    out.push({
      index: i,
      thrust,
      isp,
      fuel,
      massStart,
      massEnd,
      deltaV,
      twr: (surfaceG: number) => (massStart > 0 ? thrust / (massStart * surfaceG) : 0),
    })
  }
  return out
}

/** Total delta-v of the vehicle across all stages, m/s. */
export function totalDeltaV(v: Vehicle): number {
  return performance(v).reduce((dv, s) => dv + s.deltaV, 0)
}

/**
 * The reference rocket: a two-stage stack with ~4150 m/s of delta-v — enough to
 * reach Terra orbit with margin. Used by the smoke oracle and the tutorial.
 */
export function referenceRocket(): Vehicle {
  return {
    name: 'Pathfinder I',
    stages: [
      // Stage 0 — the booster that lights on the pad.
      { partIds: ['engine-main', 'tank-large', 'decoupler', 'fin', 'fin'] },
      // Stage 1 — the orbital insertion stage with the crew pod on top.
      { partIds: ['engine-vac', 'tank-small', 'cmd-pod'] },
    ],
  }
}
