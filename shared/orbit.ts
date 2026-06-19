// Two-body orbital mechanics in a plane — the analytic heart of the simulation.
//
// A coasting vessel follows a Keplerian conic that is an exact function of time.
// That is the whole trick behind cheap, deterministic multiplayer: the server and
// every client agree on where a coasting ship is without streaming a single byte
// of physics. We only fall back to step-integrated physics during powered or
// atmospheric flight (see physics.ts).
//
// Convention: orbits are planar. We build each conic in a "perifocal" frame whose
// +x axis points at periapsis and whose motion is counter-clockwise, then rotate
// by argPe and mirror in y for retrograde orbits (dir = -1). Mean anomaly always
// advances with +time; direction is purely a geometric mirror.

import { type Vec2, vec, add, scale, dot, cross, len, len2, rotate, TAU } from './units.ts'

export interface Elements {
  /** Semi-major axis, m. >0 ellipse, <0 hyperbola. */
  a: number
  /** Eccentricity. <1 ellipse, =1 parabola (unused), >1 hyperbola. */
  e: number
  /** Argument of periapsis: inertial angle of the periapsis direction, rad. */
  argPe: number
  /** Direction of travel: +1 counter-clockwise (prograde), -1 clockwise. */
  dir: 1 | -1
  /** Mean anomaly at epoch, rad. */
  M0: number
  /** Epoch time, s. */
  t0: number
  /** Gravitational parameter of the focus body, m^3/s^2. */
  mu: number
}

/** Solve Kepler's equation M = E - e*sin(E) for eccentric anomaly E (elliptic). */
export function solveEccentricAnomaly(M: number, e: number): number {
  let m = M % TAU
  if (m > Math.PI) m -= TAU
  if (m < -Math.PI) m += TAU
  // Newton-Raphson; the e>=1 case is handled in solveHyperbolicAnomaly.
  let E = e < 0.8 ? m : Math.PI * Math.sign(m || 1)
  for (let i = 0; i < 60; i++) {
    const f = E - e * Math.sin(E) - m
    const fp = 1 - e * Math.cos(E)
    const dE = f / fp
    E -= dE
    if (Math.abs(dE) < 1e-12) break
  }
  return E
}

/** Solve the hyperbolic Kepler equation M = e*sinh(F) - F for hyperbolic anomaly F. */
export function solveHyperbolicAnomaly(M: number, e: number): number {
  let F = Math.asinh(M / e) || Math.sign(M || 1)
  for (let i = 0; i < 100; i++) {
    const f = e * Math.sinh(F) - F - M
    const fp = e * Math.cosh(F) - 1
    const dF = f / fp
    F -= dF
    if (Math.abs(dF) < 1e-12) break
  }
  return F
}

/** Position & velocity (inertial, focus-centred) from orbital elements at time t. */
export function elementsToState(el: Elements, t: number): { pos: Vec2; vel: Vec2 } {
  const { a, e, argPe, dir, M0, t0, mu } = el
  let pPf: Vec2 // perifocal position
  let vPf: Vec2 // perifocal velocity

  if (e < 1) {
    const n = Math.sqrt(mu / (a * a * a)) // mean motion
    const M = M0 + n * (t - t0)
    const E = solveEccentricAnomaly(M, e)
    const cosE = Math.cos(E)
    const sinE = Math.sin(E)
    const r = a * (1 - e * cosE)
    const nu = Math.atan2(Math.sqrt(1 - e * e) * sinE, cosE - e)
    pPf = vec(r * Math.cos(nu), r * Math.sin(nu))
    // Velocity in perifocal frame (standard two-body relation).
    const p = a * (1 - e * e)
    const vf = Math.sqrt(mu / p)
    vPf = vec(-vf * Math.sin(nu), vf * (e + Math.cos(nu)))
  } else {
    const absA = Math.abs(a)
    const n = Math.sqrt(mu / (absA * absA * absA))
    const M = M0 + n * (t - t0)
    const F = solveHyperbolicAnomaly(M, e)
    const coshF = Math.cosh(F)
    const sinhF = Math.sinh(F)
    const r = a * (1 - e * coshF) // a<0 -> r>0
    const nu = Math.atan2(Math.sqrt(e * e - 1) * sinhF, e - coshF)
    pPf = vec(r * Math.cos(nu), r * Math.sin(nu))
    const p = a * (1 - e * e) // >0
    const vf = Math.sqrt(mu / p)
    vPf = vec(-vf * Math.sin(nu), vf * (e + Math.cos(nu)))
  }

  // Mirror for retrograde, then rotate the perifocal frame into the inertial frame.
  if (dir === -1) {
    pPf = vec(pPf.x, -pPf.y)
    vPf = vec(vPf.x, -vPf.y)
  }
  return { pos: rotate(pPf, argPe), vel: rotate(vPf, argPe) }
}

/** Orbital elements from an inertial state vector (focus-centred) at time t. */
export function stateToElements(pos: Vec2, vel: Vec2, mu: number, t: number): Elements {
  const r = len(pos)
  const v2 = len2(vel)
  const h = cross(pos, vel) // signed angular momentum (z component)
  const dir: 1 | -1 = h >= 0 ? 1 : -1

  const energy = v2 / 2 - mu / r
  const a = -mu / (2 * energy)

  // Eccentricity vector: ((v^2 - mu/r) r - (r.v) v) / mu. Points at periapsis.
  const rv = dot(pos, vel)
  const eVec = scale(add(scale(pos, v2 - mu / r), scale(vel, -rv)), 1 / mu)
  let e = len(eVec)

  let argPe: number
  if (e < 1e-9) {
    // Circular: periapsis undefined. Anchor the frame to +x.
    argPe = 0
    e = 0
  } else {
    argPe = Math.atan2(eVec.y, eVec.x)
  }

  // True anomaly: angle of r in the (un-mirrored) perifocal frame.
  const rPf = rotate(pos, -argPe)
  const nu = Math.atan2(dir * rPf.y, rPf.x)

  // Mean anomaly at epoch from true anomaly.
  let M0: number
  if (e < 1) {
    const E = Math.atan2(Math.sqrt(1 - e * e) * Math.sin(nu), e + Math.cos(nu))
    M0 = E - e * Math.sin(E)
  } else {
    const F = Math.asinh((Math.sqrt(e * e - 1) * Math.sin(nu)) / (1 + e * Math.cos(nu)))
    M0 = e * Math.sinh(F) - F
  }

  return { a, e, argPe, dir, M0, t0: t, mu }
}

/** Convenience: propagate a state vector forward (or back) by dt seconds, exactly. */
export function propagate(pos: Vec2, vel: Vec2, mu: number, t: number, dt: number): { pos: Vec2; vel: Vec2 } {
  const el = stateToElements(pos, vel, mu, t)
  return elementsToState(el, t + dt)
}

/** Periapsis & apoapsis radii (m). Apoapsis is Infinity for e>=1. */
export function apsides(el: Elements): { periapsis: number; apoapsis: number } {
  const periapsis = el.a * (1 - el.e)
  const apoapsis = el.e < 1 ? el.a * (1 + el.e) : Infinity
  return { periapsis, apoapsis }
}

/** Orbital period (s) for an ellipse; Infinity otherwise. */
export function period(el: Elements): number {
  if (el.e >= 1) return Infinity
  return TAU * Math.sqrt(el.a ** 3 / el.mu)
}

/** Sample points along an elliptical orbit path for rendering (inertial frame). */
export function orbitPath(el: Elements, segments = 128): Vec2[] {
  if (el.e >= 1) return [] // hyperbolic paths drawn elsewhere
  const pts: Vec2[] = []
  for (let i = 0; i <= segments; i++) {
    const E = (i / segments) * TAU
    const r = el.a * (1 - el.e * Math.cos(E))
    const nu = Math.atan2(Math.sqrt(1 - el.e * el.e) * Math.sin(E), Math.cos(E) - el.e)
    let p = vec(r * Math.cos(nu), r * Math.sin(nu))
    if (el.dir === -1) p = vec(p.x, -p.y)
    pts.push(rotate(p, el.argPe))
  }
  return pts
}

/** Circular orbit speed at radius r about mu. */
export const circularSpeed = (mu: number, r: number): number => Math.sqrt(mu / r)

/** Vis-viva speed at radius r on an orbit of semi-major axis a. */
export const visViva = (mu: number, r: number, a: number): number => Math.sqrt(mu * (2 / r - 1 / a))
