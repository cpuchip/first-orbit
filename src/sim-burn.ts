// Burn oracle — `npm run burntest`.
//
// Drives the headless client Game through a real mission: ascend to orbit on the
// autopilot, plan a prograde maneuver node, arm it, and let the arm→warp→auto-burn
// machine run. Asserts the resulting orbit matches the PLANNED orbit — i.e. the
// burn fires at the node and stops at Δv=0 (no over-burn, the v1 bug). Deterministic.

import { Game } from './game.ts'
import { apsides } from '../shared/orbit.ts'
import { referenceRocket } from '../shared/vehicle.ts'
import type { VesselState } from '../shared/netproto.ts'

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

// --- two chained nodes execute in sequence onto the predicted final orbit -------
{
  const g = new Game()
  g.launch(referenceRocket(), 'test2')
  if (!reachOrbit(g)) {
    check('chained: reached orbit', false, 'autopilot failed')
  } else {
    g.toggleNode() // node 0 at apoapsis
    g.adjustNode(20, 0)
    g.addNode() // node 1 at the next apoapsis of the post-burn orbit
    g.adjustNode(20, 0)
    check('two nodes queued', g.nodes.length === 2)
    const chain = g.plannedChain()
    const finalA = chain[chain.length - 1].a
    g.armNode()
    for (let i = 0; i < 800_000 && g.nodes.length; i++) g.update(0.1)
    check('queue executed (both nodes consumed)', g.nodes.length === 0)
    const afterA = g.elements().a
    check('chained burns reach the predicted orbit', rel(afterA, finalA) < 0.03, `a ${(afterA / 1e3).toFixed(0)}k vs ${(finalA / 1e3).toFixed(0)}k`)
  }
}

// --- auto-circularize rounds an eccentric orbit -------------------------------
{
  const g = new Game()
  g.launch(referenceRocket(), 'circ')
  if (!reachOrbit(g)) {
    check('circularize: reached orbit', false, 'autopilot failed')
  } else {
    check('autopilot leaves a near-circular orbit', g.elements().e < 0.06, `e=${g.elements().e.toFixed(3)}`)
    // Kick prograde to make the orbit eccentric (gentle, so leftover fuel can undo it).
    g.toggleNode()
    g.adjustNode(80, 0)
    g.armNode()
    for (let i = 0; i < 500_000 && g.node; i++) g.update(0.1)
    const ecc = g.elements().e
    check('orbit made eccentric', ecc > 0.03, `e=${ecc.toFixed(3)}`)

    // One tap: plan + arm a circularization at the next apsis. It should drive the
    // eccentricity back down sharply (toward round) at the right moment.
    const msg = g.planCircularize()
    check('circularize planned + armed', typeof msg === 'string' && msg !== 'already' && g.nodeReadout()?.armed === true, `msg=${msg}`)
    for (let i = 0; i < 800_000 && g.nodes.length; i++) g.update(0.1)
    const eAfter = g.elements().e
    check('orbit circularized (eccentricity collapses)', eAfter < 0.03 && eAfter < ecc * 0.5, `e ${eAfter.toFixed(3)} (was ${ecc.toFixed(3)})`)
  }
}

// --- autopilot survives the player time-warping during ascent -----------------
{
  const g = new Game()
  g.launch(referenceRocket(), 'warp')
  g.toggleAutopilot()
  let orbited = false
  for (let i = 0; i < 300_000; i++) {
    g.warp = 8 // the player cranks warp while the autopilot flies
    g.update(0.1)
    const r = g.readout()
    if (r.inOrbit && !r.autopilot && r.throttle === 0) { orbited = true; break }
  }
  check('autopilot reaches orbit even while warping', orbited, `peri above atmosphere=${g.readout().inOrbit}`)
}

// --- resume: re-pilot a coasting vessel after a reconnect ---------------------
{
  const g = new Game()
  g.launch(referenceRocket(), 'orig')
  if (!reachOrbit(g)) {
    check('resume: reached orbit', false, 'autopilot failed')
  } else {
    const el = g.elements()
    // The vessel as the server would have persisted it.
    const vs: VesselState = {
      id: 'resumed', owner: 'p', ownerName: 'P', name: 'Pathfinder', bodyId: 'terra', status: 'orbit',
      orbit: el, vehicle: { stages: referenceRocket().stages }, fuel: g.st.fuel, stageIndex: g.st.stageIndex,
    }
    const g2 = new Game()
    const ok = g2.resumeVessel(vs, g.st.t)
    check('resume reconstructs a flyable craft on its orbit', ok && g2.vesselId === 'resumed' && rel(g2.elements().a, el.a) < 0.02 && g2.st.fuel === g.st.fuel, `a ${(g2.elements().a / 1e3).toFixed(0)}k vs ${(el.a / 1e3).toFixed(0)}k`)
    // And it can still fly: a prograde burn raises the orbit.
    const a0 = g2.elements().a
    g2.throttle = 1
    g2.st.heading = g2.elements().argPe // roughly prograde-ish; just confirm thrust changes the orbit
    for (let i = 0; i < 200 && g2.st.fuel > 0; i++) g2.update(0.1)
    check('resumed craft still burns fuel + flies', g2.st.fuel < g.st.fuel && rel(g2.elements().a, a0) > 0.001, `a ${(g2.elements().a / 1e3).toFixed(0)}k vs ${(a0 / 1e3).toFixed(0)}k`)
  }
}

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) { for (const f of failures) console.log(`  - ${f}`); process.exit(1) }
console.log('burn oracle green ✓')
