// Maneuver nodes — plan a burn before you make it.
//
// A node is a Δv to be applied at a future point on the current orbit, expressed
// in the orbital frame (prograde along velocity, radial outward from the body).
// Given the node, we can compute the orbit that WOULD result — that's the dashed
// "planned orbit" the player tunes on the map before committing. In KSP this is
// the single most important piece of orbital gameplay; here it's built in.

import { type Vec2, add, scale, norm, len } from './units.ts'
import { elementsToState, stateToElements, type Elements } from './orbit.ts'

export interface ManeuverNode {
  /** Time of the burn, on the same clock as the orbit's epoch (seconds). */
  t: number
  /** Δv along the velocity vector, m/s (+ prograde, − retrograde). */
  prograde: number
  /** Δv along the outward radial, m/s (+ away from the body). */
  radial: number
}

/** State at the node and the unit direction the engine must point to execute it. */
export function nodeState(el: Elements, node: ManeuverNode): { pos: Vec2; vel: Vec2; newVel: Vec2; burnDir: Vec2 } {
  const { pos, vel } = elementsToState(el, node.t)
  const pro = norm(vel)
  const rad = norm(pos) // focus is at the origin, so position is the outward radial
  const dv = add(scale(pro, node.prograde), scale(rad, node.radial))
  const newVel = add(vel, dv)
  return { pos, vel, newVel, burnDir: len(dv) > 1e-9 ? norm(dv) : pro }
}

/** The orbit that results from executing the node (focus-relative elements). */
export function applyNode(el: Elements, node: ManeuverNode): Elements {
  const ns = nodeState(el, node)
  return stateToElements(ns.pos, ns.newVel, el.mu, node.t)
}

/** Total Δv magnitude of a node, m/s. */
export const nodeDeltaV = (n: ManeuverNode): number => Math.hypot(n.prograde, n.radial)

/** World burn direction (unit) for the node — what the autopilot points the ship at. */
export const nodeBurnDir = (el: Elements, node: ManeuverNode): Vec2 => nodeState(el, node).burnDir
