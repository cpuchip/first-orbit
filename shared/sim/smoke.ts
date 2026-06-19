// Smoke oracle — the deterministic floor under everything.
//
// Run with `npm run smoke`. Exit 0 = the physics still obeys the laws we built
// the game on; exit 1 = something drifted. Every assertion is exact and fast, so
// this is safe to run after every change and inside autonomous loops. It bakes in
// the inverse hypothesis (Moroni 10:4 / Agans rule 9): a test that cannot fail
// proves nothing, so we also confirm a deliberately weak rocket does NOT orbit.

import { vec, len, sub, add } from '../units.ts'
import { SYSTEM, ROOT, surfaceGravity, bodyPosition, bodyVelocity, dominantBody, referenceFrame } from '../bodies.ts'
import {
  stateToElements,
  elementsToState,
  propagate,
  apsides,
  period,
  circularSpeed,
  visViva,
} from '../orbit.ts'
import { referenceRocket, performance, totalDeltaV } from '../vehicle.ts'
import { simulateToOrbit } from '../autopilot.ts'
import { applyNode, nodeDeltaV } from '../maneuver.ts'
import type { FlightWorld } from '../physics.ts'

let passed = 0
const failures: string[] = []

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++
    console.log(`  ok  ${name}`)
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const rel = (a: number, b: number): number => Math.abs(a - b) / Math.max(1, Math.abs(b))
const close = (a: number, b: number, tol = 1e-6): boolean => rel(a, b) <= tol

const terra = SYSTEM[ROOT]
const mu = terra.mu
const world: FlightWorld = { root: ROOT, system: SYSTEM }

console.log('First Orbit — smoke oracle\n')

// --- 1. State <-> elements roundtrip (circular, eccentric, retrograde) ----------
{
  const r1 = terra.radius + 80_000
  const vc = circularSpeed(mu, r1)
  const cases: Array<[string, ReturnType<typeof vec>, ReturnType<typeof vec>]> = [
    ['circular', vec(r1, 0), vec(0, vc)],
    ['eccentric', vec(r1, 0), vec(0, vc * 1.25)],
    ['retrograde', vec(r1, 0), vec(0, -vc)],
    ['offaxis', vec(0, r1), vec(-vc * 1.1, 0)],
  ]
  for (const [label, pos, vel] of cases) {
    const el = stateToElements(pos, vel, mu, 0)
    const back = elementsToState(el, 0)
    const dp = len(sub(back.pos, pos))
    const dv = len(sub(back.vel, vel))
    check(`roundtrip ${label}`, dp < 1 && dv < 1e-3, `dpos=${dp.toFixed(3)}m dvel=${dv.toExponential(2)}`)
  }
}

// --- 2. Energy conserved on an analytic coast ----------------------------------
{
  const r1 = terra.radius + 120_000
  const vc = circularSpeed(mu, r1)
  let pos = vec(r1, 0)
  let vel = vec(0, vc * 1.3) // elliptical
  const energy0 = len(vel) ** 2 / 2 - mu / len(pos)
  let t = 0
  let maxErr = 0
  for (let i = 0; i < 50; i++) {
    const next = propagate(pos, vel, mu, t, 137) // odd dt
    pos = next.pos
    vel = next.vel
    t += 137
    const e = len(vel) ** 2 / 2 - mu / len(pos)
    maxErr = Math.max(maxErr, Math.abs(e - energy0) / Math.abs(energy0))
  }
  check('coast conserves energy', maxErr < 1e-9, `maxRelErr=${maxErr.toExponential(2)}`)
}

// --- 3. Propagating one full period returns to the start -----------------------
{
  const r1 = terra.radius + 200_000
  const vc = circularSpeed(mu, r1)
  const pos = vec(r1, 0)
  const vel = vec(0, vc * 1.15)
  const el = stateToElements(pos, vel, mu, 0)
  const T = period(el)
  const after = propagate(pos, vel, mu, 0, T)
  const dp = len(sub(after.pos, pos))
  check('period closes the orbit', dp < 5, `drift=${dp.toFixed(2)}m over T=${(T / 60).toFixed(1)}min`)
}

// --- 4. Hohmann transfer reaches the target apoapsis ---------------------------
{
  const r1 = terra.radius + 80_000
  const r2 = SYSTEM['luna'].orbitRadius! // raise apoapsis to Luna's orbit
  const aT = (r1 + r2) / 2
  const vPeri = visViva(mu, r1, aT) // speed needed at periapsis of the transfer
  const pos = vec(r1, 0)
  const vel = vec(0, vPeri) // prograde (CCW)
  const el = stateToElements(pos, vel, mu, 0)
  const { apoapsis } = apsides(el)
  check('Hohmann reaches Luna radius', close(apoapsis, r2, 1e-4), `apo=${(apoapsis / 1e6).toFixed(3)}Mm target=${(r2 / 1e6).toFixed(3)}Mm`)
}

// --- 5. Reference rocket has the delta-v and TWR to fly --------------------------
{
  const rocket = referenceRocket()
  const dv = totalDeltaV(rocket)
  const perf = performance(rocket)
  const g = surfaceGravity(terra)
  const twr0 = perf[0].twr(g)
  check('reference dv in range', dv > 3600 && dv < 4600, `dv=${dv.toFixed(0)} m/s`)
  check('liftoff TWR > 1.2', twr0 > 1.2, `twr0=${twr0.toFixed(2)}`)
}

// --- 6. The reference rocket actually reaches a stable orbit (the big one) ------
{
  const rocket = referenceRocket()
  const res = simulateToOrbit(world, rocket, { targetAltitude: 85_000, dt: 0.1 })
  const { periapsis, apoapsis } = apsides(res.elements)
  const periAlt = periapsis - terra.radius
  check(
    'reference rocket reaches orbit',
    res.inOrbit && periAlt > terra.atmosphere!.height,
    `phase=${res.phase} periAlt=${(periAlt / 1000).toFixed(1)}km apoAlt=${((apoapsis - terra.radius) / 1000).toFixed(1)}km steps=${res.steps}`,
  )
}

// --- 7. Inverse hypothesis: a weak rocket must NOT reach orbit ------------------
{
  const weak = {
    name: 'Firework',
    stages: [{ partIds: ['engine-main', 'tank-small', 'cmd-pod'] }], // far too little dv
  }
  const res = simulateToOrbit(world, weak, { targetAltitude: 85_000, dt: 0.1 })
  check('weak rocket fails to orbit (inverse)', !res.inOrbit, `phase=${res.phase}`)
}

// --- 8. Patched conics: Luna's sphere of influence ------------------------------
{
  const luna = SYSTEM['luna']
  const lunaR = luna.orbitRadius!
  // Body velocity: Luna's circular speed about Terra.
  const lv = bodyVelocity(SYSTEM, 'luna', 0)
  check('Luna orbital velocity', close(len(lv), circularSpeed(mu, lunaR), 1e-6), `|v|=${len(lv).toFixed(1)} m/s`)

  // Dominant body: Terra in low orbit, Luna when near Luna.
  const lowOrbit = vec(terra.radius + 100_000, 0)
  const nearLuna = add(bodyPosition(SYSTEM, 'luna', 0), vec(luna.radius + 50_000, 0))
  check('dominant body = Terra in low orbit', dominantBody(SYSTEM, ROOT, lowOrbit, 0) === 'terra')
  check('dominant body = Luna near Luna', dominantBody(SYSTEM, ROOT, nearLuna, 0) === 'luna')

  // SOI boundary is sharp: just outside -> Terra, just inside -> Luna.
  const justOut = add(bodyPosition(SYSTEM, 'luna', 0), vec(luna.soi + 1_000, 0))
  const justIn = add(bodyPosition(SYSTEM, 'luna', 0), vec(luna.soi - 1_000, 0))
  check('SOI boundary sharp', dominantBody(SYSTEM, ROOT, justOut, 0) === 'terra' && dominantBody(SYSTEM, ROOT, justIn, 0) === 'luna')

  // Frame continuity: relPos + Luna pos == absPos; relVel + Luna vel == absVel.
  const rf = referenceFrame(SYSTEM, ROOT, nearLuna, vec(0, len(lv) + 100), 0)
  const backPos = add(rf.relPos, bodyPosition(SYSTEM, 'luna', 0))
  check('frame transform is continuous', rf.bodyId === 'luna' && len(sub(backPos, nearLuna)) < 1e-3)

  // Capture: a vessel circular about Luna is a bound orbit in Luna's frame.
  const r = luna.radius + 50_000
  const vCircLuna = circularSpeed(luna.mu, r)
  const absPos = add(bodyPosition(SYSTEM, 'luna', 0), vec(r, 0))
  const absVel = add(bodyVelocity(SYSTEM, 'luna', 0), vec(0, vCircLuna))
  const rf2 = referenceFrame(SYSTEM, ROOT, absPos, absVel, 0)
  const elLuna = stateToElements(rf2.relPos, rf2.relVel, rf2.mu, 0)
  const periAlt = apsides(elLuna).periapsis - luna.radius
  check('low Luna orbit is bound & circular', elLuna.e < 0.01 && Math.abs(periAlt - 50_000) < 500, `e=${elLuna.e.toFixed(4)} periAlt=${(periAlt / 1000).toFixed(1)}km`)
}

// --- 9. Maneuver nodes: plan a burn, predict the orbit --------------------------
{
  // An eccentric orbit; periapsis at (r1,0) since v there exceeds circular.
  const r1 = terra.radius + 100_000
  const vc = circularSpeed(mu, r1)
  const el = stateToElements(vec(r1, 0), vec(0, vc * 1.3), mu, 0)
  const ra = apsides(el).apoapsis
  const tApo = period(el) / 2 // apoapsis is half a period after periapsis

  // Zero node is a no-op.
  const same = applyNode(el, { t: tApo, prograde: 0, radial: 0 })
  check('zero node is a no-op', close(same.a, el.a, 1e-6) && Math.abs(same.e - el.e) < 1e-6)

  // Circularize at apoapsis: prograde Δv = vCirc(ra) - vApo.
  const vApo = visViva(mu, ra, el.a)
  const dv = circularSpeed(mu, ra) - vApo
  const node = { t: tApo, prograde: dv, radial: 0 }
  const circ = applyNode(el, node)
  check(
    'circularization node yields a circular orbit',
    circ.e < 0.005 && Math.abs(apsides(circ).periapsis - ra) < ra * 0.005,
    `e=${circ.e.toFixed(4)} dv=${nodeDeltaV(node).toFixed(0)} m/s`,
  )
}

// --- Summary --------------------------------------------------------------------
console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) {
  console.log('\nFAILURES:')
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}
console.log('oracle green ✓')
