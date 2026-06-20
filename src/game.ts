// Client-side flight driver.
//
// Runs the shared deterministic physics locally during powered/atmospheric flight
// and switches to the analytic propagator for on-rails time-warp while coasting —
// the same two-regime split the server relies on. Streams active flight to the
// server and "settles" the vessel onto an authoritative orbit when it stabilises.

import { SYSTEM, ROOT, surfaceGravity, referenceFrame, bodyVelocity, bodyPosition } from '../shared/bodies.ts'
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
import { osculating, currentBodyId } from '../shared/autopilot.ts'
import { apsides, stateToElements } from '../shared/orbit.ts'
import { propagate, type Elements } from '../shared/orbit.ts'
import { type ManeuverNode, applyNode, nodeDeltaV, nodeBurnDir } from '../shared/maneuver.ts'
import { planTransfer } from '../shared/transfer.ts'
import { type Vec2, sub, add, scale, norm, dot, rotate, angleOf, len, wrapAngle, TAU } from '../shared/units.ts'
import type { Vehicle } from '../shared/vehicle.ts'
import { FLIGHT_HZ, type ClientMsg } from '../shared/netproto.ts'
import type { MilestoneKind } from '../shared/milestones.ts'

export type FlightPhase = 'prelaunch' | 'ascent' | 'coast' | 'circularize'
export type HoldMode = 'off' | 'prograde' | 'retrograde' | 'radial-out' | 'radial-in' | 'target' | 'anti-target' | 'tgt-prograde' | 'tgt-retrograde' | 'node'
export interface TargetRef { kind: 'vessel' | 'body'; id: string; name: string }

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
  bodyName: string
  landed: boolean
  hold: HoldMode
  nodeArmed: boolean
  burning: boolean
  targetName: string | null
  targetKind: 'vessel' | 'body' | null
  targetDist: number | null
  targetRelSpeed: number | null
}

const ROOT_BODY = SYSTEM[ROOT]
const ATMO = ROOT_BODY.atmosphere?.height ?? 0
const HOLD_RATE = 2.5 // rad/s heading slew under SAS / node hold
const PHYS_WARP_MAX = 4 // physics warp (works on the ground / in atmosphere)
const WARP_LADDER = [1, 2, 3, 4, 10, 50, 100, 1000, 10000, 100000]

/** Rotate `cur` toward `target` by at most `maxStep` radians. */
function slew(cur: number, target: number, maxStep: number): number {
  const d = wrapAngle(target - cur)
  return Math.abs(d) <= maxStep ? target : cur + Math.sign(d) * maxStep
}

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
  private milestoneFired = new Set<MilestoneKind>()
  private wasInSpace = false
  nodes: ManeuverNode[] = []
  private editIdx = 0
  /** The node currently being edited / shown (nodes are fired chronologically from index 0). */
  get node(): ManeuverNode | null {
    return this.nodes[this.editIdx] ?? null
  }
  get activeNodeIdx(): number {
    return this.editIdx
  }
  private nodeArmed = false
  private executingNode = false
  private nodeRemaining = 0
  private armedChain: Elements[] = [] // planned orbits frozen at arm time (so the line doesn't move while burning)
  hold: HoldMode = 'off'
  target: TargetRef | null = null
  targetPos: Vec2 | null = null // world pos of the target, set by the App each frame
  targetVel: Vec2 | null = null
  send: (m: ClientMsg) => void = () => {}
  onMilestone: (kind: MilestoneKind) => void = () => {}

  launch(vehicle: Vehicle, vesselId: string, startT = 0): void {
    this.stages = flightStages(vehicle)
    this.st = launchState(this.world, this.stages, startT)
    this.vesselId = vesselId
    this.throttle = 0
    this.autopilot = false
    this.warp = 1
    this.apPhase = 'ascent'
    this.settled = false
    this.milestoneFired.clear()
    this.wasInSpace = false
    this.nodes = []
    this.editIdx = 0
    this.nodeArmed = false
    this.executingNode = false
    this.hold = 'off'
    this.target = null
    this.targetPos = null
    this.targetVel = null
  }

  stageNow(): void {
    this.stageReq = true
  }
  toggleAutopilot(): void {
    this.autopilot = !this.autopilot
    if (this.autopilot) this.apPhase = 'ascent'
  }
  warpUp(): void {
    this.warp = WARP_LADDER.find((w) => w > this.warp) ?? this.warp
  }
  warpDown(): void {
    for (let i = WARP_LADDER.length - 1; i >= 0; i--) if (WARP_LADDER[i] < this.warp) return void (this.warp = WARP_LADDER[i])
    this.warp = 1
  }

  // --- SAS heading hold ---------------------------------------------------
  setHold(m: HoldMode): void {
    this.hold = this.hold === m ? 'off' : m
    if (this.hold !== 'off') {
      this.autopilot = false
      this.nodeArmed = false
      this.executingNode = false
    }
  }
  private holdHeading(): number | null {
    const rf = referenceFrame(SYSTEM, ROOT, this.st.pos, this.st.vel, this.st.t)
    switch (this.hold) {
      case 'prograde': return len(rf.relVel) > 0.5 ? angleOf(rf.relVel) : null
      case 'retrograde': return len(rf.relVel) > 0.5 ? angleOf(scale(rf.relVel, -1)) : null
      case 'radial-out': return angleOf(rf.relPos)
      case 'radial-in': return angleOf(scale(rf.relPos, -1))
      case 'target': return this.targetPos ? angleOf(sub(this.targetPos, this.st.pos)) : null
      case 'anti-target': return this.targetPos ? angleOf(sub(this.st.pos, this.targetPos)) : null
      case 'tgt-prograde': return this.targetVel ? angleOf(sub(this.st.vel, this.targetVel)) : null
      case 'tgt-retrograde': return this.targetVel ? angleOf(sub(this.targetVel, this.st.vel)) : null
      case 'node': return this.nodes[0] ? angleOf(nodeBurnDir(this.elements(), this.nodes[0])) : null
      default: return null
    }
  }

  // --- targeting ----------------------------------------------------------
  setTarget(t: TargetRef | null): void {
    this.target = t
    this.targetPos = null
    this.targetVel = null
    if (!t && this.hold.startsWith('t')) this.hold = 'off' // target / tgt-prograde / tgt-retrograde
  }

  // --- maneuver nodes (a chronological queue) -----------------------------
  /** The planned orbit after each node, chaining from the live orbit. */
  plannedChain(): Elements[] {
    const out: Elements[] = []
    let base = this.elements()
    for (const n of this.nodes) {
      base = applyNode(base, n)
      out.push(base)
    }
    return out
  }
  /** Append a node at the next apoapsis of the last planned orbit (or the live one). */
  addNode(): void {
    const chain = this.plannedChain()
    const base = chain.length ? chain[chain.length - 1] : this.elements()
    const afterT = this.nodes.length ? this.nodes[this.nodes.length - 1].t : this.st.t
    const absA = Math.abs(base.a)
    const n = Math.sqrt(base.mu / (absA * absA * absA))
    let dt = 120
    if (base.e < 1) dt = ((((Math.PI - base.M0) % TAU) + TAU) % TAU) / n
    this.nodes.push({ t: Math.max(base.t0 + dt, afterT + 1), prograde: 0, radial: 0 })
    this.editIdx = this.nodes.length - 1
  }
  /** N key: create the first node, or clear the whole queue if any exist. */
  toggleNode(): void {
    if (this.nodes.length) {
      this.nodes = []
      this.editIdx = 0
      this.nodeArmed = false
      this.executingNode = false
      if (this.hold === 'node') this.hold = 'off'
    } else {
      this.addNode()
    }
  }
  removeActiveNode(): void {
    if (!this.nodes.length) return
    this.nodes.splice(this.editIdx, 1)
    this.editIdx = Math.max(0, Math.min(this.editIdx, this.nodes.length - 1))
    if (!this.nodes.length) this.nodeArmed = false
  }
  cycleNode(dir: number): void {
    if (this.nodes.length) this.editIdx = (this.editIdx + dir + this.nodes.length) % this.nodes.length
  }
  adjustNode(dPrograde: number, dRadial: number): void {
    const n = this.node
    if (n && !this.executingNode) {
      n.prograde += dPrograde
      n.radial += dRadial
    }
  }
  moveNode(dt: number): void {
    const n = this.node
    if (n && !this.executingNode) n.t = Math.max(this.st.t + 1, n.t + dt)
  }
  /** Arm/disarm the queue: warps to each node in turn and auto-burns it, centred. */
  armNode(): void {
    if (!this.nodes.length) return
    if (this.nodeArmed) {
      this.disarmNode()
      return
    }
    this.nodeArmed = true
    this.executingNode = false
    this.autopilot = false
    this.hold = 'off'
    this.nodeRemaining = nodeDeltaV(this.nodes[0])
    this.armedChain = this.plannedChain() // freeze the projection for the burn
  }
  private disarmNode(): void {
    this.nodeArmed = false
    this.executingNode = false
    this.throttle = 0
    this.warp = 1
    this.armedChain = []
  }
  private completeNode(): void {
    this.executingNode = false
    this.throttle = 0
    this.nodes.shift() // drop the burned node; the next becomes nodes[0]
    this.armedChain.shift()
    this.editIdx = Math.max(0, Math.min(this.editIdx, this.nodes.length - 1))
    if (this.nodes.length) {
      this.nodeRemaining = nodeDeltaV(this.nodes[0]) // keep armed for the next node
    } else {
      this.nodeArmed = false
      this.armedChain = []
      if (this.hold === 'node') this.hold = 'off'
    }
  }
  /** Auto-plan a phase-timed transfer to a body, replacing the node queue. Returns a summary. */
  planTransferTo(destId: string): string | null {
    const dest = SYSTEM[destId]
    if (!dest || destId === currentBodyId(this.world, this.st)) return null
    const plan = planTransfer(this.elements(), SYSTEM, dest, this.st.t)
    if (!plan) return null
    this.nodes = plan.nodes
    this.editIdx = 0
    this.nodeArmed = false
    this.executingNode = false
    this.armedChain = []
    return plan.summary
  }
  plannedElements(): Elements | null {
    const chain = this.plannedChain()
    return chain[this.editIdx] ?? null
  }
  /** Planned orbits to DISPLAY — frozen while burning so the line doesn't drift. */
  chainForDisplay(): Elements[] {
    return this.executingNode && this.armedChain.length ? this.armedChain : this.plannedChain()
  }
  nodeReadout(): { pro: number; rad: number; dv: number; tMinus: number; apoAlt: number; periAlt: number; armed: boolean; executing: boolean; index: number; count: number } | null {
    const n = this.node
    if (!n) return null
    const planned = this.plannedElements()!
    const body = SYSTEM[currentBodyId(this.world, this.st)]
    const { apoapsis, periapsis } = apsides(planned)
    return {
      pro: n.prograde,
      rad: n.radial,
      dv: this.nodeArmed && this.editIdx === 0 ? this.nodeRemaining : nodeDeltaV(n),
      tMinus: n.t - this.st.t,
      apoAlt: (planned.e < 1 ? apoapsis : Infinity) - body.radius,
      periAlt: periapsis - body.radius,
      armed: this.nodeArmed,
      executing: this.executingNode,
      index: this.editIdx,
      count: this.nodes.length,
    }
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
    const burnNode = this.nodes[0]
    if (this.nodeArmed && burnNode) {
      // Arm -> point at the burn -> warp to the node -> auto-burn CENTRED on it,
      // tapering the throttle to a clean stop. The burn only starts inside the
      // window around the node, so arming early never over-burns the plan.
      const rf = referenceFrame(SYSTEM, ROOT, this.st.pos, this.st.vel, this.st.t)
      const burnDir = norm(add(scale(norm(rf.relVel), burnNode.prograde), scale(norm(rf.relPos), burnNode.radial)))
      const desired = angleOf(burnDir)
      this.st.heading = slew(this.st.heading, desired, HOLD_RATE * dt)
      const stage = this.stages[this.st.stageIndex]
      const mass = currentMass(this.stages, this.st)
      const accel = stage && this.st.fuel > 1e-6 && mass > 0 ? stage.thrust / mass : 0
      const burnTimeFull = accel > 0 ? nodeDeltaV(burnNode) / accel : 1e9
      const tToNode = burnNode.t - this.st.t
      const lead = Math.min(burnTimeFull / 2 + 1, 1e9)
      const aligned = Math.abs(wrapAngle(this.st.heading - desired)) < 0.08
      if (!this.executingNode) {
        this.throttle = 0
        this.warp = tToNode > lead + 3 ? (tToNode > 600 ? 1000 : tToNode > 60 ? 100 : 10) : 1
        if (tToNode <= lead && aligned) this.executingNode = true
      }
      if (this.executingNode) {
        this.warp = 1
        this.throttle = Math.max(0.04, Math.min(1, this.nodeRemaining / 15)) // taper near Δv=0
        if (accel > 0) this.nodeRemaining -= accel * this.throttle * dt
        if (this.st.fuel <= 1e-6 && this.st.stageIndex < this.stages.length - 1) this.stageReq = true
        if (this.nodeRemaining <= 0.05) this.completeNode()
        else if (this.st.fuel <= 1e-6 && this.st.stageIndex >= this.stages.length - 1) this.disarmNode()
      }
    } else if (this.autopilot) {
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
      this.hold = 'off'
      this.st.heading += this.rotateInput * 1.8 * dt
    } else if (this.hold !== 'off') {
      const d = this.holdHeading()
      if (d !== null) this.st.heading = slew(this.st.heading, d, HOLD_RATE * dt)
    }

    // Auto-stage whenever we're commanding thrust on a dry tank (autopilot
    // ascent, node burns, or a held throttle) — drop the spent stage so the
    // next engine lights instead of stranding.
    if (this.throttle > 0 && this.st.fuel <= 1e-6 && this.st.stageIndex < this.stages.length - 1) this.stageReq = true
    // Out of fuel on the last stage: release the autopilot gracefully (don't hold
    // throttle forever on a dead engine).
    if (this.autopilot && this.st.fuel <= 1e-6 && this.st.stageIndex >= this.stages.length - 1) {
      this.autopilot = false
      this.throttle = 0
    }

    // Warp: physics warp (≤4×) works anywhere — even on the pad and in atmosphere;
    // on-rails warp (>4×) needs coasting out of the atmosphere. Node auto-burns
    // force 1× (set in the arm machine).
    const onRails = this.throttle === 0 && alt > ATMO
    if (this.warp > PHYS_WARP_MAX && !onRails) this.warp = PHYS_WARP_MAX

    // --- integrate ----------------------------------------------------------
    if (this.warp > PHYS_WARP_MAX && onRails) {
      // On-rails warp in the current dominant body's frame (patched conics).
      const rf = referenceFrame(SYSTEM, ROOT, this.st.pos, this.st.vel, this.st.t)
      const t2 = this.st.t + dtReal * this.warp
      const rel = propagate(rf.relPos, rf.relVel, rf.mu, this.st.t, dtReal * this.warp)
      this.st = {
        ...this.st,
        pos: add(rel.pos, bodyPosition(SYSTEM, rf.bodyId, t2)),
        vel: add(rel.vel, bodyVelocity(SYSTEM, rf.bodyId, t2)),
        t: t2,
      }
    } else {
      // Stepped physics, sped up by physics-warp (more substeps per frame).
      const span = dt * Math.min(this.warp, PHYS_WARP_MAX)
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
    const bodyId = currentBodyId(this.world, this.st)
    const body = SYSTEM[bodyId]
    const bodyAtmo = body.atmosphere?.height ?? 0
    const stableOrbit = this.throttle === 0 && el.e < 1 && periapsis > body.radius + bodyAtmo

    // --- milestone detection (fire each once) -------------------------------
    if (alt > ATMO) this.wasInSpace = true
    const fire = (k: MilestoneKind) => {
      if (!this.milestoneFired.has(k)) {
        this.milestoneFired.add(k)
        this.onMilestone(k)
      }
    }
    const bound = el.e < 1 && periapsis > body.radius + bodyAtmo
    if (!this.st.landed && this.st.t > 2 && alt > 500) fire('launch')
    if (bound && bodyId === 'terra') fire('orbit')
    if (bodyId === 'luna') fire('luna_soi')
    if (bound && bodyId === 'luna') fire('luna_orbit')
    if (this.st.landed && bodyId === 'luna') fire('luna_landing')
    if (this.st.landed && bodyId === 'terra' && this.wasInSpace && this.st.t > 5) fire('return')
    const settledStatus = this.st.landed ? 'landed' : stableOrbit ? 'orbit' : null
    if (settledStatus && !this.settled) {
      this.send({ type: 'settle', vesselId: this.vesselId, orbit: el, status: settledStatus, bodyId })
      this.settled = true
    } else if (!settledStatus && this.netAccum >= 1 / FLIGHT_HZ) {
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

  currentBody(): string {
    return currentBodyId(this.world, this.st)
  }

  readout(): Readout {
    // Everything is framed by the body whose SOI we're in.
    const rf = referenceFrame(SYSTEM, ROOT, this.st.pos, this.st.vel, this.st.t)
    const body = SYSTEM[rf.bodyId]
    const el = stateToElements(rf.relPos, rf.relVel, rf.mu, this.st.t)
    const { apoapsis, periapsis } = apsides(el)
    const upRel = norm(rf.relPos)
    const mass = currentMass(this.stages, this.st)
    const stage = this.stages[this.st.stageIndex]
    const g = surfaceGravity(body)
    const bodyAtmo = body.atmosphere?.height ?? 0
    return {
      altitude: len(rf.relPos) - body.radius,
      speed: len(rf.relVel),
      verticalSpeed: dot(rf.relVel, upRel),
      apoapsisAlt: (el.e < 1 ? apoapsis : Infinity) - body.radius,
      periapsisAlt: periapsis - body.radius,
      throttle: this.throttle,
      fuel: this.st.fuel,
      stage: this.st.stageIndex,
      stageCount: this.stages.length,
      mass,
      twr: stage && mass > 0 && this.st.fuel > 0 ? (this.throttle * stage.thrust) / (mass * g) : 0,
      autopilot: this.autopilot,
      warp: this.warp,
      inOrbit: el.e < 1 && periapsis > body.radius + bodyAtmo,
      heading: this.st.heading,
      bodyName: body.name,
      landed: this.st.landed,
      hold: this.hold,
      nodeArmed: this.nodeArmed,
      burning: this.executingNode,
      targetName: this.target?.name ?? null,
      targetKind: this.target?.kind ?? null,
      targetDist: this.targetPos ? len(sub(this.targetPos, this.st.pos)) : null,
      targetRelSpeed: this.targetPos && this.targetVel ? len(sub(this.st.vel, this.targetVel)) : null,
    }
  }

  elements(): Elements {
    return osculating(this.world, this.st)
  }
}
