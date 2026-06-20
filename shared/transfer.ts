// Transfer planner — the "fly me to it" button.
//
// Planning a transfer by hand is the hardest part of orbital play: you must burn
// at the right *time* so the destination is where your transfer ellipse arrives,
// not where it is now. This computes that phase-timed burn for ANY orbiting
// target — a moon (with an estimated capture burn) or a piece of junk / another
// ship (just get into the neighbourhood, then match velocity to close in).
//
// Assumes the vessel is in a roughly circular orbit in the same frame as the
// target (e.g. both around Terra).

import { type Body, bodyPosition } from './bodies.ts'
import { type Elements, elementsToState, circularSpeed, visViva, period } from './orbit.ts'
import { angleOf, wrapAngle, len } from './units.ts'
import type { ManeuverNode } from './maneuver.ts'

export interface TransferPlan {
  nodes: ManeuverNode[]
  /** Human summary for Mission Control. */
  summary: string
}

/** What we're transferring to: an orbit radius, how fast it sweeps, and where it is. */
export interface TransferTarget {
  name: string
  radius: number // orbit radius to transfer to, m
  rate: number // target's angular rate, rad/s (signed for direction)
  angleAt: (t: number) => number // target's inertial angle at time t
  /** A body to capture into; omit for junk / ships (you just rendezvous). */
  capture?: { mu: number; radius: number }
}

/** Build a transfer target from a moon/planet (with capture). */
export function bodyTarget(system: Record<string, Body>, dest: Body): TransferTarget | null {
  if (!dest.orbitRadius || dest.orbitRate === undefined) return null
  return {
    name: dest.name,
    radius: dest.orbitRadius,
    rate: dest.orbitRate,
    angleAt: (t) => angleOf(bodyPosition(system, dest.id, t)),
    capture: { mu: dest.mu, radius: dest.radius + Math.max(50_000, dest.radius * 0.25) },
  }
}

/** Build a transfer target from an orbiting object (junk or a ship) — no capture. */
export function orbitTarget(name: string, orbit: Elements): TransferTarget {
  const n = Math.sqrt(orbit.mu / orbit.a ** 3) * orbit.dir
  return {
    name,
    radius: orbit.a,
    rate: n,
    angleAt: (t) => angleOf(elementsToState(orbit, t).pos),
  }
}

/** Plan a phase-timed Hohmann transfer from the vessel's orbit to `target`. */
export function planTransfer(el: Elements, target: TransferTarget, tNow: number): TransferPlan | null {
  const mu = el.mu
  if (el.e >= 0.5) return null // need a roughly circular starting orbit
  const r1 = len(elementsToState(el, tNow).pos) // current radius
  const r2 = target.radius
  if (!(r2 > 0) || Math.abs(r2 - r1) < r1 * 0.02) return null // already at that radius / invalid

  // Hohmann transfer ellipse between r1 and r2 (works inward or outward).
  const aT = (r1 + r2) / 2
  const tTransfer = Math.PI * Math.sqrt(aT ** 3 / mu)

  // The target must lead the burn point by (π − how far it travels during the
  // transfer). Find the next time the actual lead matches.
  const requiredLead = wrapAngle(Math.PI - target.rate * tTransfer)
  const f = (t: number): number => wrapAngle(target.angleAt(t) - angleOf(elementsToState(el, t).pos) - requiredLead)

  const vPeriod = period(el)
  if (!Number.isFinite(vPeriod)) return null
  const stepN = 360
  const horizon = vPeriod * 2.2
  let tBurn = -1
  let tPrev = tNow
  let prev = f(tNow)
  for (let i = 1; i <= stepN; i++) {
    const t = tNow + (horizon * i) / stepN
    const cur = f(t)
    if (Math.sign(prev) !== Math.sign(cur) && Math.abs(cur - prev) < Math.PI) {
      let lo = tPrev
      let hi = t
      const sLo = Math.sign(f(lo))
      for (let k = 0; k < 44; k++) {
        const mid = (lo + hi) / 2
        if (Math.sign(f(mid)) === sLo) lo = mid
        else hi = mid
      }
      tBurn = (lo + hi) / 2
      break
    }
    tPrev = t
    prev = cur
  }
  if (tBurn < 0) return null

  // Injection burn at the current radius (prograde to raise, retrograde to lower).
  const inject = visViva(mu, r1, aT) - circularSpeed(mu, r1)
  const nodes: ManeuverNode[] = [{ t: tBurn, prograde: inject, radial: 0 }]
  const mins = Math.round((tBurn - tNow) / 60)
  const coast = tTransfer > 3600 ? `${(tTransfer / 3600).toFixed(1)} h` : `${Math.round(tTransfer / 60)} min`

  if (target.capture) {
    // At arrival the vessel's speed differs from the body's; that excess sets the
    // retrograde capture burn into a low circular orbit there.
    const vInf = Math.abs(circularSpeed(mu, r2) - visViva(mu, r2, aT))
    const rCap = target.capture.radius
    const vHyp = Math.sqrt(vInf * vInf + (2 * target.capture.mu) / rCap)
    const cap: ManeuverNode = { t: tBurn + tTransfer, prograde: -(vHyp - circularSpeed(target.capture.mu, rCap)), radial: 0 }
    nodes.push(cap)
    return {
      nodes,
      summary: `${target.name} transfer: inject ${Math.round(inject)} m/s in ${mins} min, then ~${Math.round(-cap.prograde)} m/s to capture (${coast} coast).`,
    }
  }

  return {
    nodes,
    summary: `${target.name} rendezvous: ${inject >= 0 ? '+' : ''}${Math.round(inject)} m/s in ${mins} min → arrive near it after a ${coast} coast. Use the target SAS (T▲/T▼) to match velocity and close in.`,
  }
}
