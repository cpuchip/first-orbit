// Powered / atmospheric flight — the step-integrated regime.
//
// While an engine is burning or the vehicle is in atmosphere, the orbit is not a
// clean conic, so we integrate Newton's laws with RK4: gravity from every body,
// thrust along the heading (consuming propellant per the rocket equation), and
// exponential-atmosphere drag. The moment the vehicle is coasting in vacuum, the
// game hands control back to the analytic propagator in orbit.ts.

import { type Vec2, vec, add, scale, sub, len, norm, fromAngle } from './units.ts'
import { type Body, airDensity, bodyPosition, bodyVelocity } from './bodies.ts'
import { G0 } from './units.ts'
import type { Vehicle } from './vehicle.ts'
import { part } from './parts.ts'

/** A stage flattened for the flight sim. */
export interface FlightStage {
  thrust: number
  ve: number // exhaust velocity = Isp * g0
  fuel: number // kg
  dryMass: number // kg
  dragArea: number // m^2 (this stage's parts)
  massAbove: number // kg of all stages above (assumed full)
}

export interface FlightState {
  t: number
  pos: Vec2
  vel: Vec2
  heading: number // thrust direction, rad
  throttle: number // 0..1
  stageIndex: number
  fuel: number // kg remaining in the current stage
  /** Below-surface contact flag. */
  landed: boolean
}

export interface FlightControls {
  throttle: number
  heading: number
  /** Request a stage separation this step. */
  stage?: boolean
}

export interface FlightWorld {
  root: string // root body id (the launch body / inertial origin)
  system: Record<string, Body>
}

/** Flatten a vehicle into per-stage flight data (bottom-up). */
export function flightStages(v: Vehicle): FlightStage[] {
  const wet = v.stages.map((s) => ({
    dry: s.partIds.reduce((m, id) => m + part(id).dryMass, 0),
    fuel: s.partIds.reduce((m, id) => m + (part(id).fuel ?? 0), 0),
    thrust: s.partIds.reduce((t, id) => t + (part(id).thrust ?? 0), 0),
    isp: (() => {
      const es = s.partIds.map(part).filter((p) => p.kind === 'engine')
      const tot = es.reduce((t, e) => t + (e.thrust ?? 0), 0)
      return tot === 0 ? 0 : es.reduce((a, e) => a + (e.isp ?? 0) * (e.thrust ?? 0), 0) / tot
    })(),
    dragArea: s.partIds.reduce((a, id) => a + part(id).dragArea, 0),
  }))
  return wet.map((s, i) => ({
    thrust: s.thrust,
    ve: s.isp * G0,
    fuel: s.fuel,
    dryMass: s.dry,
    dragArea: s.dragArea,
    massAbove: wet.slice(i + 1).reduce((m, up) => m + up.dry + up.fuel, 0),
  }))
}

/** Current total mass of the vehicle given its flight state. */
export function currentMass(stages: FlightStage[], st: FlightState): number {
  const s = stages[st.stageIndex]
  if (!s) return 0
  return s.massAbove + s.dryMass + st.fuel
}

/** Total lumped drag area from the current stage up. */
function currentDragArea(stages: FlightStage[], idx: number): number {
  return stages.slice(idx).reduce((a, s) => a + s.dragArea, 0)
}

/** Net gravitational acceleration from all bodies at a position and time. */
export function gravityAccel(world: FlightWorld, pos: Vec2, t: number): Vec2 {
  let ax = 0
  let ay = 0
  for (const b of Object.values(world.system)) {
    const bp = bodyPosition(world.system, b.id, t)
    const d = sub(pos, bp)
    const r2 = d.x * d.x + d.y * d.y
    const r = Math.sqrt(r2)
    if (r < 1) continue
    const g = -b.mu / (r2 * r) // = -mu/r^2 * (d/r)
    ax += g * d.x
    ay += g * d.y
  }
  return vec(ax, ay)
}

/** Altitude above the root body's surface, m. */
export function altitude(world: FlightWorld, pos: Vec2, t: number): number {
  const root = world.system[world.root]
  const rp = bodyPosition(world.system, world.root, t)
  return len(sub(pos, rp)) - root.radius
}

// Total acceleration: gravity + thrust + drag. Mass & thrust fixed across the substep.
function accel(
  world: FlightWorld,
  pos: Vec2,
  vel: Vec2,
  t: number,
  mass: number,
  thrustForce: number,
  heading: number,
  dragArea: number,
): Vec2 {
  let a = gravityAccel(world, pos, t)
  if (thrustForce > 0 && mass > 0) {
    a = add(a, scale(fromAngle(heading), thrustForce / mass))
  }
  // Drag from the root body's atmosphere only.
  const root = world.system[world.root]
  if (root.atmosphere) {
    const alt = altitude(world, pos, t)
    const rho = airDensity(root, alt)
    if (rho > 0) {
      const speed = len(vel)
      if (speed > 0) {
        const dragMag = 0.5 * rho * speed * speed * dragArea
        a = add(a, scale(norm(vel), -dragMag / mass))
      }
    }
  }
  return a
}

/** One fixed-step (RK4) integration of the flight state. */
export function step(
  world: FlightWorld,
  stages: FlightStage[],
  st: FlightState,
  ctrl: FlightControls,
  dt: number,
): FlightState {
  let stageIndex = st.stageIndex
  let fuel = st.fuel

  // Staging request: drop to the next stage with a full tank.
  if (ctrl.stage && stageIndex < stages.length - 1) {
    stageIndex += 1
    fuel = stages[stageIndex].fuel
  }

  const stage = stages[stageIndex]
  const throttle = Math.max(0, Math.min(1, ctrl.throttle))
  const hasFuel = fuel > 0
  const thrustForce = hasFuel ? throttle * stage.thrust : 0
  const heading = ctrl.heading
  const dragArea = currentDragArea(stages, stageIndex)

  const mass0 = stage.massAbove + stage.dryMass + fuel

  // RK4 on (pos, vel) with mass/thrust held constant over the step.
  const f = (p: Vec2, v: Vec2, tt: number) => ({
    dp: v,
    dv: accel(world, p, v, tt, mass0, thrustForce, heading, dragArea),
  })
  const k1 = f(st.pos, st.vel, st.t)
  const k2 = f(add(st.pos, scale(k1.dp, dt / 2)), add(st.vel, scale(k1.dv, dt / 2)), st.t + dt / 2)
  const k3 = f(add(st.pos, scale(k2.dp, dt / 2)), add(st.vel, scale(k2.dv, dt / 2)), st.t + dt / 2)
  const k4 = f(add(st.pos, scale(k3.dp, dt)), add(st.vel, scale(k3.dv, dt)), st.t + dt)

  const pos = add(
    st.pos,
    scale(add(add(k1.dp, scale(k2.dp, 2)), add(scale(k3.dp, 2), k4.dp)), dt / 6),
  )
  let vel = add(
    st.vel,
    scale(add(add(k1.dv, scale(k2.dv, 2)), add(scale(k3.dv, 2), k4.dv)), dt / 6),
  )

  // Burn propellant.
  if (thrustForce > 0 && stage.ve > 0) {
    const mdot = thrustForce / stage.ve
    fuel = Math.max(0, fuel - mdot * dt)
  }

  // Ground contact with whichever body the vessel has penetrated (Terra or Luna).
  let landed = false
  let finalPos = pos
  for (const b of Object.values(world.system)) {
    const bp = bodyPosition(world.system, b.id, st.t + dt)
    const radial = sub(pos, bp)
    if (len(radial) < b.radius) {
      const up = norm(radial)
      finalPos = add(bp, scale(up, b.radius))
      const bv = bodyVelocity(world.system, b.id, st.t + dt)
      const relVel = sub(vel, bv)
      const vr = up.x * relVel.x + up.y * relVel.y
      if (vr < 0) vel = sub(vel, scale(up, vr)) // cancel inward radial; no bounce
      landed = len(sub(vel, bv)) < 3 // touchdown is slow relative to the body
      break
    }
  }

  return { t: st.t + dt, pos: finalPos, vel, heading, throttle, stageIndex, fuel, landed }
}

/** Build the on-pad initial state for a launch straight "up" (+y) from the root body. */
export function launchState(world: FlightWorld, stages: FlightStage[]): FlightState {
  const root = world.system[world.root]
  const rp = bodyPosition(world.system, world.root, 0)
  return {
    t: 0,
    pos: vec(rp.x, rp.y + root.radius),
    vel: vec(0, 0),
    heading: Math.PI / 2, // straight up
    throttle: 0,
    stageIndex: 0,
    fuel: stages[0]?.fuel ?? 0,
    landed: true,
  }
}
