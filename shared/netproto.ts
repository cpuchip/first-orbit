// Wire protocol shared by client and server.
//
// The multiplayer model is a SHARED SPACE PROGRAM: every player flies their own
// missions, but they all share one solar system, one universe clock, and a roster
// of each other's vessels. Coasting vessels travel on analytic orbits (see
// orbit.ts), so the server stays authoritative over the persistent universe
// cheaply — it only relays the short bursts of active, powered flight.

import type { Elements } from './orbit.ts'
import type { MilestoneKind } from './milestones.ts'
import type { DebrisDef } from './debris.ts'

export interface ContractState {
  id: string
  claimedBy: string | null // player id, or null if open
  claimedName: string | null
}

export const SNAPSHOT_HZ = 10 // server -> client universe snapshots per second
export const FLIGHT_HZ = 20 // client -> server active-flight updates per second
export const PROTOCOL_VERSION = 1

/** A vessel as the universe knows it. Either coasting (orbit) or actively flown (flight). */
export interface VesselState {
  id: string
  owner: string // player id
  ownerName: string
  name: string
  bodyId: string // the body whose frame the orbit/flight is in
  status: 'prelaunch' | 'flight' | 'orbit' | 'landed' | 'wreck'
  /** Set while coasting — analytic orbit. */
  orbit?: Elements
  /** Set while actively flown — last streamed flight snapshot. */
  flight?: { x: number; y: number; vx: number; vy: number; heading: number; t: number }
  /** The rocket design, so the craft can be re-piloted after a reconnect. */
  vehicle?: { stages: { partIds: string[] }[] }
  /** Remaining propellant (kg) in the current stage + which stage — for resume. */
  fuel?: number
  stageIndex?: number
}

export interface PlayerInfo {
  id: string
  name: string
  color: string
  funds: number
  science: number
  achieved: MilestoneKind[]
  tech: number // highest unlocked tech tier
}

// ---- client -> server ----------------------------------------------------------
export type ClientMsg =
  | { type: 'hello'; name: string; room: string; protocol: number }
  | { type: 'launch'; vesselName: string; bodyId: string; cost: number; vehicle?: { stages: { partIds: string[] }[] } }
  | { type: 'unlock_tech'; tier: number }
  | { type: 'flight'; vesselId: string; x: number; y: number; vx: number; vy: number; heading: number; t: number; fuel?: number; stageIndex?: number }
  | { type: 'settle'; vesselId: string; orbit: Elements; status: VesselState['status']; bodyId: string; fuel?: number; stageIndex?: number }
  | { type: 'recover'; vesselId: string }
  | { type: 'milestone'; vesselId: string; kind: MilestoneKind }
  | { type: 'claim_contract'; id: string }
  | { type: 'salvage'; id: string }
  | { type: 'chat'; text: string }
  | { type: 'ping' }

// ---- server -> client ----------------------------------------------------------
export type ServerMsg =
  | { type: 'welcome'; you: PlayerInfo; room: string; universeTime: number; players: PlayerInfo[]; vessels: VesselState[]; contracts: ContractState[]; debris: DebrisDef[]; build: string }
  | { type: 'players'; players: PlayerInfo[] }
  | { type: 'contracts'; contracts: ContractState[] }
  | { type: 'contract_claimed'; id: string; playerName: string; color: string; funds: number; science: number; ts: number }
  | { type: 'debris'; debris: DebrisDef[] }
  | { type: 'salvaged'; id: string; name: string; playerName: string; color: string; funds: number; science: number; ts: number }
  | { type: 'snapshot'; universeTime: number; vessels: VesselState[] }
  | { type: 'vesselCreated'; vessel: VesselState }
  | { type: 'achievement'; playerName: string; color: string; kind: MilestoneKind; funds: number; science: number; first: boolean; ts: number }
  | { type: 'chat'; from: string; color: string; text: string; ts: number }
  | { type: 'error'; message: string }
  | { type: 'pong' }

export const encode = (m: ClientMsg | ServerMsg): string => JSON.stringify(m)
export const decode = <T>(s: string): T => JSON.parse(s) as T
