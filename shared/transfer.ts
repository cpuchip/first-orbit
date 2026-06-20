// Transfer planner — the "fly me to the Moon" button.
//
// Planning an interplanetary/interlunar transfer by hand is the hardest part of
// orbital play: you must burn at the right *time* so the destination is where
// your transfer ellipse arrives, not where it is now. This computes that — a
// phase-timed trans-lunar injection (the keystone) plus an estimated capture burn.
//
// Assumes the vessel is in a roughly circular orbit around the parent of the
// destination body (e.g. a Terra orbit, transferring to Luna).

import { type Body, bodyPosition } from './bodies.ts'
import { type Elements, elementsToState, circularSpeed, visViva, period } from './orbit.ts'
import { angleOf, wrapAngle, len } from './units.ts'
import type { ManeuverNode } from './maneuver.ts'

export interface TransferPlan {
  nodes: ManeuverNode[]
  /** Human summary for Mission Control. */
  summary: string
}

/**
 * Plan a Hohmann transfer from the vessel's current orbit to an orbit of `dest`.
 * Returns null if the geometry doesn't suit a simple transfer.
 */
export function planTransfer(
  el: Elements,
  system: Record<string, Body>,
  dest: Body,
  tNow: number,
): TransferPlan | null {
  if (!dest.orbitRadius || dest.orbitRate === undefined) return null
  const mu = el.mu // parent (e.g. Terra) gravitational parameter
  if (el.e >= 0.5) return null // need a roughly circular starting orbit

  // Current orbit radius (use the current distance) and the destination's radius.
  const r1 = el.a * (1 - el.e * el.e) / (1 + el.e) > 0 ? len(elementsToState(el, tNow).pos) : el.a
  const r2 = dest.orbitRadius
  if (r2 <= r1) return null // only outward transfers for now

  // Hohmann transfer ellipse: periapsis r1, apoapsis r2.
  const aT = (r1 + r2) / 2
  const tTransfer = Math.PI * Math.sqrt(aT ** 3 / mu)
  const wDest = dest.orbitRate

  // The destination must LEAD the burn point by (π − how far it travels during the
  // transfer). Find the next time the actual lead matches.
  const requiredLead = wrapAngle(Math.PI - wDest * tTransfer)
  const f = (t: number): number => {
    const vesselAngle = angleOf(elementsToState(el, t).pos)
    const destAngle = angleOf(bodyPosition(system, dest.id, t))
    return wrapAngle(destAngle - vesselAngle - requiredLead)
  }

  // Search forward for the next zero crossing (the vessel sweeps fast relative to
  // dest, so the relative angle changes monotonically between crossings). Direction
  // -agnostic: any sign change that isn't the ±π wrap discontinuity.
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

  // Injection: prograde Δv at the burn point to raise apoapsis to r2.
  const vCirc = circularSpeed(mu, r1)
  const vPeri = visViva(mu, r1, aT)
  const tli: ManeuverNode = { t: tBurn, prograde: vPeri - vCirc, radial: 0 }

  // Capture: at arrival the vessel is slower than the destination; the speed
  // difference is the hyperbolic excess at the dest's sphere of influence. Estimate
  // the retrograde burn to drop into a low circular orbit there.
  const vApo = visViva(mu, r2, aT) // vessel speed at apoapsis (Terra frame)
  const vDestOrbit = circularSpeed(mu, r2) // dest's own speed
  const vInf = Math.abs(vDestOrbit - vApo)
  const rCap = dest.radius + Math.max(50_000, dest.radius * 0.25)
  const vHyp = Math.sqrt(vInf * vInf + (2 * dest.mu) / rCap)
  const vCircDest = circularSpeed(dest.mu, rCap)
  const capture: ManeuverNode = { t: tBurn + tTransfer, prograde: -(vHyp - vCircDest), radial: 0 }

  return {
    nodes: [tli, capture],
    summary: `${dest.name} transfer: inject ${Math.round(tli.prograde)} m/s in ${Math.round((tBurn - tNow) / 60)} min, then ~${Math.round(-capture.prograde)} m/s to capture (${(tTransfer / 3600).toFixed(1)} h coast).`,
  }
}
