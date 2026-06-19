// Wire protocol shared by client and server.
//
// The multiplayer model is a SHARED SPACE PROGRAM: every player flies their own
// missions, but they all share one solar system, one universe clock, and a roster
// of each other's vessels. Coasting vessels travel on analytic orbits (see
// orbit.ts), so the server stays authoritative over the persistent universe
// cheaply — it only relays the short bursts of active, powered flight.

import type { Elements } from './orbit.ts'
import type { MilestoneKind } from './milestones.ts'

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
}

export interface PlayerInfo {
  id: string
  name: string
  color: string
  funds: number
  science: number
  achieved: MilestoneKind[]
}

// ---- client -> server ----------------------------------------------------------
export type ClientMsg =
  | { type: 'hello'; name: string; protocol: number }
  | { type: 'launch'; vesselName: string; bodyId: string }
  | { type: 'flight'; vesselId: string; x: number; y: number; vx: number; vy: number; heading: number; t: number }
  | { type: 'settle'; vesselId: string; orbit: Elements; status: VesselState['status']; bodyId: string }
  | { type: 'recover'; vesselId: string }
  | { type: 'milestone'; vesselId: string; kind: MilestoneKind }
  | { type: 'chat'; text: string }
  | { type: 'ping' }

// ---- server -> client ----------------------------------------------------------
export type ServerMsg =
  | { type: 'welcome'; you: PlayerInfo; universeTime: number; players: PlayerInfo[]; vessels: VesselState[]; build: string }
  | { type: 'players'; players: PlayerInfo[] }
  | { type: 'snapshot'; universeTime: number; vessels: VesselState[] }
  | { type: 'vesselCreated'; vessel: VesselState }
  | { type: 'achievement'; playerName: string; color: string; kind: MilestoneKind; funds: number; science: number; first: boolean; ts: number }
  | { type: 'chat'; from: string; color: string; text: string; ts: number }
  | { type: 'error'; message: string }
  | { type: 'pong' }

export const encode = (m: ClientMsg | ServerMsg): string => JSON.stringify(m)
export const decode = <T>(s: string): T => JSON.parse(s) as T
