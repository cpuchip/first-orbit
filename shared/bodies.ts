// Celestial bodies of the Terra system — the home cradle of the Hubble Frontier.
//
// Bodies are scaled ~1/10 of their real-world analogues (Kerbal Space Program's
// trick) so that a player-built rocket can reach orbit with a realistic-feeling
// few thousand m/s of delta-v. The physics (gravity, atmosphere, orbits) is real;
// only the scale is friendly.
//
// Progression arc of the campaign: reach orbit around TERRA -> land on LUNA ->
// (later) reach MARS and lay the keel of the orbital shipyards ("Mars-field").

import { G, type Vec2, sub } from './units.ts'

export interface Atmosphere {
  /** Altitude (m above sea level) where the atmosphere effectively ends. */
  height: number
  /** Density scale height (m): density = seaLevelDensity * exp(-alt/scaleHeight). */
  scaleHeight: number
  /** Sea-level air density, kg/m^3. */
  seaLevelDensity: number
}

export interface Body {
  id: string
  name: string
  /** Standard gravitational parameter GM, m^3/s^2. */
  mu: number
  /** Mean radius (sea level / surface), m. */
  radius: number
  /** Sidereal rotation period, s (surface velocity for launches). */
  rotationPeriod: number
  /** Sphere-of-influence radius, m. Beyond this the parent body dominates. */
  soi: number
  atmosphere?: Atmosphere
  /** Parent body id (undefined = the root of the system). */
  parent?: string
  /** Circular orbit radius around the parent, m (undefined for the root). */
  orbitRadius?: number
  /** Mean angular rate around the parent, rad/s (derived; see buildSystem). */
  orbitRate?: number
  /** Phase angle at t=0, rad. */
  orbitPhase0?: number
  /** Render hint. */
  color: string
}

// Terra — the homeworld. Kerbin-like: 600 km radius, ~3400 m/s to low orbit.
const TERRA: Body = {
  id: 'terra',
  name: 'Terra',
  mu: 3.5316e12,
  radius: 600_000,
  rotationPeriod: 21_549,
  soi: 84_159_286,
  atmosphere: { height: 70_000, scaleHeight: 5_600, seaLevelDensity: 1.225 },
  color: '#3a7bd5',
}

// Luna — Terra's moon. Mun-like: airless, 200 km radius, 12,000 km out.
const LUNA: Body = {
  id: 'luna',
  name: 'Luna',
  mu: 6.5138e10,
  radius: 200_000,
  rotationPeriod: 138_984,
  soi: 2_429_559,
  parent: 'terra',
  orbitRadius: 12_000_000,
  orbitPhase0: 0,
  color: '#b9b6ad',
}

/** Build the system, deriving each child body's circular orbit rate from its parent's mu. */
export function buildSystem(): Record<string, Body> {
  const sys: Record<string, Body> = {}
  for (const b of [TERRA, LUNA]) sys[b.id] = { ...b }
  for (const b of Object.values(sys)) {
    if (b.parent && b.orbitRadius) {
      const parent = sys[b.parent]
      // Circular orbit: v = sqrt(mu/r), rate = v/r = sqrt(mu/r^3).
      b.orbitRate = Math.sqrt(parent.mu / b.orbitRadius ** 3)
    }
  }
  return sys
}

export const SYSTEM = buildSystem()
export const ROOT = TERRA.id

/** Position of a body in the root (Terra-centred) inertial frame at time t (s). */
export function bodyPosition(
  sys: Record<string, Body>,
  id: string,
  t: number,
): { x: number; y: number } {
  const b = sys[id]
  if (!b.parent || !b.orbitRadius || b.orbitRate === undefined) return { x: 0, y: 0 }
  const parent = bodyPosition(sys, b.parent, t)
  const theta = (b.orbitPhase0 ?? 0) + b.orbitRate * t
  return { x: parent.x + b.orbitRadius * Math.cos(theta), y: parent.y + b.orbitRadius * Math.sin(theta) }
}

/** Velocity of a body in the root inertial frame at time t (m/s). */
export function bodyVelocity(sys: Record<string, Body>, id: string, t: number): Vec2 {
  const b = sys[id]
  if (!b.parent || !b.orbitRadius || b.orbitRate === undefined) return { x: 0, y: 0 }
  const parentV = bodyVelocity(sys, b.parent, t)
  const theta = (b.orbitPhase0 ?? 0) + b.orbitRate * t
  const speed = b.orbitRate * b.orbitRadius
  return { x: parentV.x - speed * Math.sin(theta), y: parentV.y + speed * Math.cos(theta) }
}

/**
 * The body whose sphere of influence currently dominates a position — the
 * patched-conic reference body. Returns the deepest (smallest-SOI) body that
 * contains the point, falling back to the root.
 */
export function dominantBody(sys: Record<string, Body>, root: string, absPos: Vec2, t: number): string {
  let best = root
  let bestSoi = Infinity
  for (const b of Object.values(sys)) {
    if (!b.parent) continue // root is the fallback, not a candidate
    const bp = bodyPosition(sys, b.id, t)
    const d = Math.hypot(absPos.x - bp.x, absPos.y - bp.y)
    if (d < b.soi && b.soi < bestSoi) {
      best = b.id
      bestSoi = b.soi
    }
  }
  return best
}

export interface RefFrame {
  bodyId: string
  mu: number
  relPos: Vec2
  relVel: Vec2
}

/** Resolve an absolute state into the frame of its dominant body (patched conics). */
export function referenceFrame(
  sys: Record<string, Body>,
  root: string,
  absPos: Vec2,
  absVel: Vec2,
  t: number,
): RefFrame {
  const id = dominantBody(sys, root, absPos, t)
  return { bodyId: id, mu: sys[id].mu, relPos: sub(absPos, bodyPosition(sys, id, t)), relVel: sub(absVel, bodyVelocity(sys, id, t)) }
}

/** Surface gravity (m/s^2) at sea level. */
export const surfaceGravity = (b: Body): number => b.mu / (b.radius * b.radius)

/** Atmospheric density (kg/m^3) at an altitude above sea level. */
export function airDensity(b: Body, altitude: number): number {
  if (!b.atmosphere || altitude < 0) {
    if (!b.atmosphere) return 0
  }
  const a = b.atmosphere
  if (!a || altitude >= a.height) return 0
  const alt = Math.max(0, altitude)
  return a.seaLevelDensity * Math.exp(-alt / a.scaleHeight)
}

/** Mass of a body, kg (derived from mu). */
export const bodyMass = (b: Body): number => b.mu / G
