// Ascent autopilot — a gravity-turn guidance loop.
//
// In Kerbal Space Program this is the single most-installed mod (MechJeb's ascent
// guidance). Here it ships in the base game: a "fly me to orbit" button. It is
// also the deterministic driver the smoke oracle uses to prove that a sound
// rocket actually reaches a stable orbit.

import { type Vec2, sub, add, scale, norm, dot, rotate, angleOf, len } from './units.ts'
import { bodyPosition } from './bodies.ts'
import { stateToElements, apsides, type Elements } from './orbit.ts'
import {
  type FlightWorld,
  type FlightState,
  type FlightStage,
  flightStages,
  launchState,
  step,
  altitude,
} from './physics.ts'
import type { Vehicle } from './vehicle.ts'

/** Radial (up) unit vector from the root body at a flight state. */
function upDir(world: FlightWorld, st: FlightState): Vec2 {
  const rp = bodyPosition(world.system, world.root, st.t)
  return norm(sub(st.pos, rp))
}

/** Prograde tangential heading (rad) for an orbit going direction `dir`. */
function tangentialHeading(world: FlightWorld, st: FlightState, dir: 1 | -1): number {
  const up = upDir(world, st)
  return angleOf(rotate(up, (dir * Math.PI) / 2))
}

/** Osculating orbital elements relative to the root body (which is stationary at origin). */
export function osculating(world: FlightWorld, st: FlightState): Elements {
  const rp = bodyPosition(world.system, world.root, st.t)
  const rel = sub(st.pos, rp)
  return stateToElements(rel, st.vel, world.system[world.root].mu, st.t)
}

export interface AscentOptions {
  /** Target apoapsis altitude above the surface, m. */
  targetAltitude?: number
  /** Orbit direction: +1 CCW (default), -1 CW. */
  dir?: 1 | -1
  /** Integration step, s. */
  dt?: number
  /** Safety cap on steps. */
  maxSteps?: number
  /** Altitude where the gravity turn begins, m. */
  turnStart?: number
  /** Altitude where the turn finishes (near-horizontal), m. */
  turnEnd?: number
}

export type AscentPhase = 'ascent' | 'coast' | 'circularize' | 'orbit' | 'failed'

export interface AscentResult {
  phase: AscentPhase
  state: FlightState
  elements: Elements
  steps: number
  /** Whether a stable orbit clear of the atmosphere was achieved. */
  inOrbit: boolean
}

/**
 * Fly the vehicle from the pad to a (near-)circular orbit, auto-staging when a
 * stage runs dry. Deterministic given the same inputs.
 */
export function simulateToOrbit(world: FlightWorld, vehicle: Vehicle, opts: AscentOptions = {}): AscentResult {
  const root = world.system[world.root]
  const atmoHeight = root.atmosphere?.height ?? 0
  const targetAlt = opts.targetAltitude ?? atmoHeight + 15_000
  const targetRadius = root.radius + targetAlt
  const dir = opts.dir ?? 1
  const dt = opts.dt ?? 0.1
  const maxSteps = opts.maxSteps ?? 200_000
  const turnStart = opts.turnStart ?? 1_000
  const turnEnd = opts.turnEnd ?? 45_000

  const stages: FlightStage[] = flightStages(vehicle)
  let st = launchState(world, stages)
  let phase: AscentPhase = 'ascent'
  let steps = 0
  let everAirborne = false

  for (; steps < maxSteps; steps++) {
    const el = osculating(world, st)
    const { apoapsis, periapsis } = apsides(el)
    const alt = altitude(world, st.pos, st.t)
    const up = upDir(world, st)
    const radialSpeed = dot(st.vel, up)
    // Apoapsis is only meaningful on a bound (elliptical) orbit. At lift-off the
    // velocity is near-radial (e>=1, apoapsis=Infinity); ignore it until the
    // gravity turn gives us a real ellipse.
    const apoReady = el.e < 1 && apoapsis >= targetRadius

    let throttle = 0
    let heading = st.heading

    if (phase === 'ascent') {
      throttle = 1
      const frac = Math.max(0, Math.min(1, (alt - turnStart) / (turnEnd - turnStart)))
      const upW = 1 - frac
      const tangent = rotate(up, (dir * Math.PI) / 2)
      const desired = norm(add(scale(up, upW), scale(tangent, 1 - upW)))
      heading = angleOf(desired)
      if (apoReady) phase = 'coast'
    } else if (phase === 'coast') {
      throttle = 0
      heading = tangentialHeading(world, st, dir)
      // Drag bled the apoapsis back below target -> climb again.
      if (el.e < 1 && apoapsis < targetRadius - 1_000 && radialSpeed > 0) phase = 'ascent'
      // Begin the circularization burn as we approach apoapsis above the atmosphere.
      else if (alt >= atmoHeight && radialSpeed < 40) phase = 'circularize'
    } else if (phase === 'circularize') {
      throttle = 1
      heading = tangentialHeading(world, st, dir)
      if (periapsis >= root.radius + atmoHeight + 2_000) {
        phase = 'orbit'
        break
      }
      // Overshot apoapsis far and still not circular -> stop burning down.
      if (radialSpeed < -200) {
        throttle = 1 // keep trying; prograde burn still raises periapsis
      }
    }

    // Auto-stage if the current stage is dry and we still want thrust.
    let stage = false
    if (throttle > 0 && st.fuel <= 1e-6 && st.stageIndex < stages.length - 1) stage = true
    // Out of fuel entirely while still needing thrust -> failure.
    if (throttle > 0 && st.fuel <= 1e-6 && st.stageIndex >= stages.length - 1) {
      phase = 'failed'
      break
    }

    st = step(world, stages, st, { throttle, heading, stage }, dt)
    if (!st.landed) everAirborne = true

    // Fell back to the surface after having flown — a failed launch.
    // (A successful orbit breaks out of the loop above before reaching here.)
    if (st.landed && everAirborne) {
      phase = 'failed'
      break
    }
  }

  const elements = osculating(world, st)
  const { periapsis } = apsides(elements)
  const inOrbit = phase === 'orbit' && periapsis >= root.radius + atmoHeight
  return { phase, state: st, elements, steps, inOrbit }
}

/** Live single-step guidance for the in-game autopilot button. */
export function ascentControl(
  world: FlightWorld,
  st: FlightState,
  opts: AscentOptions = {},
): { throttle: number; heading: number } {
  const dir = opts.dir ?? 1
  const turnStart = opts.turnStart ?? 1_000
  const turnEnd = opts.turnEnd ?? 45_000
  const alt = altitude(world, st.pos, st.t)
  const up = upDir(world, st)
  const frac = Math.max(0, Math.min(1, (alt - turnStart) / (turnEnd - turnStart)))
  const upW = 1 - frac
  const tangent = rotate(up, (dir * Math.PI) / 2)
  const desired = norm(add(scale(up, upW), scale(tangent, 1 - upW)))
  return { throttle: 1, heading: angleOf(desired) }
}

/** Speed (m/s) relative to the root body's centre — handy for HUD readouts. */
export const orbitalSpeed = (st: FlightState): number => len(st.vel)
