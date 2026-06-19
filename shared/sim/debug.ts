import { SYSTEM, ROOT } from '../bodies.ts'
import { referenceRocket } from '../vehicle.ts'
import { flightStages, launchState, step, altitude } from '../physics.ts'
import { osculating } from '../autopilot.ts'
import { apsides } from '../orbit.ts'
import { len, sub, norm, rotate, angleOf, add, scale } from '../units.ts'
import { bodyPosition } from '../bodies.ts'

const world = { root: ROOT, system: SYSTEM }
const stages = flightStages(referenceRocket())
console.log('stages:', stages.map((s) => ({ thrust: s.thrust, fuel: s.fuel, dry: s.dryMass, above: s.massAbove })))
let st = launchState(world, stages)
const dt = 0.1
for (let i = 0; i <= 600; i++) {
  const alt = altitude(world, st.pos, st.t)
  const up = norm(sub(st.pos, bodyPosition(SYSTEM, ROOT, st.t)))
  const frac = Math.max(0, Math.min(1, (alt - 1000) / (44000)))
  const upW = 1 - frac
  const tangent = rotate(up, Math.PI / 2)
  const desired = norm(add(scale(up, upW), scale(tangent, 1 - upW)))
  const heading = angleOf(desired)
  let stage = false
  if (st.fuel <= 1e-6 && st.stageIndex < stages.length - 1) stage = true
  if (i % 50 === 0) {
    const el = osculating(world, st)
    const ap = apsides(el)
    console.log(
      `i=${i} t=${st.t.toFixed(0)} alt=${(alt / 1000).toFixed(2)}km spd=${len(st.vel).toFixed(0)} stg=${st.stageIndex} fuel=${st.fuel.toFixed(0)} landed=${st.landed} apo=${((ap.apoapsis - SYSTEM[ROOT].radius) / 1000).toFixed(1)}km peri=${((ap.periapsis - SYSTEM[ROOT].radius) / 1000).toFixed(1)}km`,
    )
  }
  st = step(world, stages, st, { throttle: 1, heading, stage }, dt)
}
