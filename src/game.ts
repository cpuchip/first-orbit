// Client-side flight driver.
//
// Runs the shared deterministic physics locally during powered/atmospheric flight
// and switches to the analytic propagator for on-rails time-warp while coasting —
// the same two-regime split the server relies on. Streams active flight to the
// server and "settles" the vessel onto an authoritative orbit when it stabilises.

import { SYSTEM, ROOT, surfaceGravity } from '../shared/bodies.ts'
import {
  type FlightWorld,
  type FlightState,
  type FlightStage,
  flightStages,
  launchState,
  step,
  altitude,
  currentMass,
} from '../shared/physics.ts'
import { osculating } from '../shared/autopilot.ts'
import { apsides } from '../shared/orbit.ts'
import { propagate, type Elements } from '../shared/orbit.ts'
import { type Vec2, sub, add, scale, norm, dot, rotate, angleOf, len } from '../shared/units.ts'
import { bodyPosition } from '../shared/bodies.ts'
import type { Vehicle } from '../shared/vehicle.ts'
import { FLIGHT_HZ, type ClientMsg } from '../shared/netproto.ts'

export type FlightPhase = 'prelaunch' | 'ascent' | 'coast' | 'circularize'

export interface Readout {
  altitude: number
  speed: number
  verticalSpeed: number
  apoapsisAlt: number
  periapsisAlt: number
  throttle: number
  fuel: number
  stage: number
  stageCount: number
  mass: number
  twr: number
  autopilot: boolean
  warp: number
  inOrbit: boolean
  heading: number
}

const ROOT_BODY = SYSTEM[ROOT]
const ATMO = ROOT_BODY.atmosphere?.height ?? 0

export class Game {
  world: FlightWorld = { root: ROOT, system: SYSTEM }
  stages: FlightStage[] = []
  st!: FlightState
  vesselId = ''
  throttle = 0
  autopilot = false
  warp = 1
  targetAlt = ATMO + 20_000
  rotateInput = 0 // -1 / 0 / +1, manual yaw
  private stageReq = false
  private apPhase: FlightPhase = 'ascent'
  private settled = false
  private netAccum = 0
  send: (m: ClientMsg) => void = () => {}

  launch(vehicle: Vehicle, vesselId: string): void {
    this.stages = flightStages(vehicle)
    this.st = launchState(this.world, this.stages)
    this.vesselId = vesselId
    this.throttle = 0
    this.autopilot = false
    this.warp = 1
    this.apPhase = 'ascent'
    this.settled = false
  }

  stageNow(): void {
    this.stageReq = true
  }
  toggleAutopilot(): void {
    this.autopilot = !this.autopilot
    if (this.autopilot) this.apPhase = 'ascent'
  }

  private up(): Vec2 {
    return norm(sub(this.st.pos, bodyPosition(SYSTEM, ROOT, this.st.t)))
  }
  private prograde(): number {
    const v = this.st.vel
    return len(v) > 1 ? angleOf(v) : angleOf(rotate(this.up(), Math.PI / 2))
  }

  update(dtReal: number): void {
    if (!this.st) return
    const dt = Math.min(dtReal, 0.1)
    const el = osculating(this.world, this.st)
    const { apoapsis, periapsis } = apsides(el)
    const targetR = ROOT_BODY.radius + this.targetAlt
    const alt = altitude(this.world, this.st.pos, this.st.t)
    const up = this.up()
    const vSpeed = dot(this.st.vel, up)

    // --- guidance -----------------------------------------------------------
    if (this.autopilot) {
      const apoReady = el.e < 1 && apoapsis >= targetR
      if (this.apPhase === 'ascent') {
        this.throttle = 1
        const frac = Math.max(0, Math.min(1, (alt - 1000) / 44000))
        const desired = norm(add(scale(up, 1 - frac), scale(rotate(up, Math.PI / 2), frac)))
        this.st.heading = angleOf(desired)
        if (apoReady) this.apPhase = 'coast'
      } else if (this.apPhase === 'coast') {
        this.throttle = 0
        this.st.heading = this.prograde()
        if (alt >= ATMO && vSpeed < 40) this.apPhase = 'circularize'
      } else {
        this.throttle = 1
        this.st.heading = this.prograde()
        if (periapsis >= ROOT_BODY.radius + ATMO + 2000) {
          this.autopilot = false
          this.throttle = 0
        }
      }
    } else if (this.rotateInput !== 0) {
      this.st.heading += this.rotateInput * 1.8 * dt
    }

    // Throttle forces warp back to 1 — you cannot warp under power.
    const coasting = this.throttle === 0 && alt > ATMO
    if (!coasting) this.warp = 1

    // --- integrate ----------------------------------------------------------
    if (this.warp > 1 && coasting) {
      const rootPos = bodyPosition(SYSTEM, ROOT, this.st.t)
      const rel = propagate(sub(this.st.pos, rootPos), this.st.vel, ROOT_BODY.mu, this.st.t, dtReal * this.warp)
      const t2 = this.st.t + dtReal * this.warp
      this.st = { ...this.st, pos: add(rel.pos, bodyPosition(SYSTEM, ROOT, t2)), vel: rel.vel, t: t2 }
    } else {
      const span = dt
      const n = Math.max(1, Math.ceil(span / 0.05))
      const sdt = span / n
      for (let i = 0; i < n; i++) {
        this.st = step(this.world, this.stages, this.st, {
          throttle: this.throttle,
          heading: this.st.heading,
          stage: this.stageReq,
        }, sdt)
        this.stageReq = false
      }
    }

    // --- server sync --------------------------------------------------------
    this.netAccum += dtReal
    const stableOrbit = this.throttle === 0 && el.e < 1 && periapsis > ROOT_BODY.radius + ATMO
    if (stableOrbit && !this.settled) {
      this.send({ type: 'settle', vesselId: this.vesselId, orbit: el, status: 'orbit' })
      this.settled = true
    } else if (!stableOrbit && this.netAccum >= 1 / FLIGHT_HZ) {
      this.settled = false
      this.send({
        type: 'flight',
        vesselId: this.vesselId,
        x: this.st.pos.x, y: this.st.pos.y,
        vx: this.st.vel.x, vy: this.st.vel.y,
        heading: this.st.heading, t: this.st.t,
      })
      this.netAccum = 0
    }
  }

  readout(): Readout {
    const el = osculating(this.world, this.st)
    const { apoapsis, periapsis } = apsides(el)
    const up = this.up()
    const mass = currentMass(this.stages, this.st)
    const stage = this.stages[this.st.stageIndex]
    const g = surfaceGravity(ROOT_BODY)
    return {
      altitude: altitude(this.world, this.st.pos, this.st.t),
      speed: len(this.st.vel),
      verticalSpeed: dot(this.st.vel, up),
      apoapsisAlt: (el.e < 1 ? apoapsis : Infinity) - ROOT_BODY.radius,
      periapsisAlt: periapsis - ROOT_BODY.radius,
      throttle: this.throttle,
      fuel: this.st.fuel,
      stage: this.st.stageIndex,
      stageCount: this.stages.length,
      mass,
      twr: stage && mass > 0 && this.st.fuel > 0 ? (this.throttle * stage.thrust) / (mass * g) : 0,
      autopilot: this.autopilot,
      warp: this.warp,
      inOrbit: el.e < 1 && periapsis > ROOT_BODY.radius + ATMO,
      heading: this.st.heading,
    }
  }

  elements(): Elements {
    return osculating(this.world, this.st)
  }
}
