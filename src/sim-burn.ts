// Burn oracle — `npm run burntest`.
//
// Drives the headless client Game through a real mission: ascend to orbit on the
// autopilot, plan a prograde maneuver node, arm it, and let the arm→warp→auto-burn
// machine run. Asserts the resulting orbit matches the PLANNED orbit — i.e. the
// burn fires at the node and stops at Δv=0 (no over-burn, the v1 bug). Deterministic.

import { Game } from './game.ts'
import { apsides } from '../shared/orbit.ts'
import { referenceRocket } from '../shared/vehicle.ts'

let passed = 0
const failures: string[] = []
const check = (name: string, cond: boolean, detail = '') => {
  if (cond) { passed++; console.log(`  ok  ${name}`) } else { failures.push(`${name} — ${detail}`); console.log(`FAIL  ${name} — ${detail}`) }
}
const rel = (a: number, b: number) => Math.abs(a - b) / Math.max(1, Math.abs(b))

function reachOrbit(g: Game): boolean {
  g.toggleAutopilot()
  for (let i = 0; i < 200_000; i++) {
    g.update(0.1)
    const r = g.readout()
    if (r.inOrbit && !r.autopilot && r.throttle === 0) return true
  }
  return false
}

console.log('First Orbit — burn oracle\n')

// --- a prograde node executed by the arm machine lands on the planned orbit -----
{
  const g = new Game()
  g.launch(referenceRocket(), 'test')
  const orbited = reachOrbit(g)
  check('autopilot reaches orbit', orbited, `alt=${(g.readout().altitude / 1000).toFixed(0)}km`)

  // Plan a small prograde burn (raises the far side) the leftover fuel can finish;
  // capture the predicted orbit.
  g.toggleNode()
  g.adjustNode(50, 0) // +50 m/s prograde
  const planned = g.plannedElements()!
  const plannedA = planned.a
  const plannedApo = apsides(planned).apoapsis

  // Arm: warp to the node, point at the burn, auto-burn centred, taper to a stop.
  g.armNode()
  let burned = false
  for (let i = 0; i < 500_000 && g.node; i++) {
    g.update(0.1)
    if (g.readout().burning) burned = true
  }
  check('node armed -> auto-burned', burned && g.node === null)

  const after = g.elements()
  const afterA = after.a
  const afterApo = apsides(after).apoapsis
  check(
    'burn hits the planned orbit (no over-burn)',
    rel(afterA, plannedA) < 0.02 && rel(afterApo, plannedApo) < 0.03,
    `a: ${(afterA / 1e3).toFixed(0)}k vs ${(plannedA / 1e3).toFixed(0)}k · apo: ${(afterApo / 1e3).toFixed(0)}k vs ${(plannedApo / 1e3).toFixed(0)}k`,
  )
}

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) { for (const f of failures) console.log(`  - ${f}`); process.exit(1) }
console.log('burn oracle green ✓')
