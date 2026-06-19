// The shared space program — the authoritative universe state.
//
// One Program instance holds the universe clock, the player roster, and every
// vessel. Coasting vessels are stored as analytic orbits, so "where is everyone"
// is a function of the clock, not a physics loop. State is persisted to disk so
// in-progress programs survive a redeploy (the same idea as deadweight's rooms).

import fs from 'node:fs'
import path from 'node:path'
import { nanoid } from 'nanoid'
import type { PlayerInfo, VesselState } from '../shared/netproto.ts'
import { MILESTONES, RECOVERY_FUNDS, type MilestoneKind } from '../shared/milestones.ts'

const COLORS = ['#e74c3c', '#3498db', '#2ecc71', '#f1c40f', '#9b59b6', '#1abc9c', '#e67e22', '#ecf0f1']

interface Persisted {
  startWall: number
  players: PlayerInfo[]
  vessels: VesselState[]
  firsts?: Record<string, string> // milestone kind -> player id who got there first
}

export interface AwardResult {
  newly: boolean
  first: boolean
  funds: number
  science: number
}

export class Program {
  private startWall: number
  private players = new Map<string, PlayerInfo>()
  private vessels = new Map<string, VesselState>()
  private firsts = new Map<string, string>() // milestone kind -> first player id
  private stateFile: string
  private dirty = false

  constructor(stateFile: string) {
    this.stateFile = stateFile
    const loaded = this.load()
    this.startWall = loaded?.startWall ?? Date.now()
    for (const p of loaded?.players ?? []) this.players.set(p.id, { ...p, achieved: p.achieved ?? [] })
    for (const v of loaded?.vessels ?? []) this.vessels.set(v.id, v)
    for (const [k, v] of Object.entries(loaded?.firsts ?? {})) this.firsts.set(k, v)
    // Persist on a slow cadence; flushes are cheap and the file is small.
    setInterval(() => this.flush(), 5_000).unref?.()
  }

  /** Universe time in seconds since the program began (real-time, 1x). */
  universeTime(): number {
    return (Date.now() - this.startWall) / 1000
  }

  /** Find-or-create a player by display name, so reconnects keep their progress. */
  join(name: string): PlayerInfo {
    const trimmed = name.trim().slice(0, 24) || 'Engineer'
    for (const p of this.players.values()) if (p.name === trimmed) return p
    const info: PlayerInfo = {
      id: nanoid(8),
      name: trimmed,
      color: COLORS[this.players.size % COLORS.length],
      funds: 25_000,
      science: 0,
      achieved: [],
    }
    this.players.set(info.id, info)
    this.dirty = true
    return info
  }

  roster(): PlayerInfo[] {
    return [...this.players.values()]
  }

  allVessels(): VesselState[] {
    return [...this.vessels.values()]
  }

  player(id: string): PlayerInfo | undefined {
    return this.players.get(id)
  }

  createVessel(owner: PlayerInfo, vesselName: string, bodyId: string): VesselState {
    const v: VesselState = {
      id: nanoid(10),
      owner: owner.id,
      ownerName: owner.name,
      name: vesselName.trim().slice(0, 32) || 'Unnamed',
      bodyId,
      status: 'flight',
    }
    this.vessels.set(v.id, v)
    this.dirty = true
    return v
  }

  /** Apply an active-flight snapshot from the controlling client. */
  updateFlight(
    vesselId: string,
    owner: string,
    f: { x: number; y: number; vx: number; vy: number; heading: number; t: number },
  ): void {
    const v = this.vessels.get(vesselId)
    if (!v || v.owner !== owner) return
    v.flight = f
    v.orbit = undefined
    v.status = 'flight'
  }

  /** Settle a vessel onto an authoritative analytic orbit when it stops burning. */
  settle(vesselId: string, owner: string, orbit: VesselState['orbit'], status: VesselState['status'], bodyId: string): void {
    const v = this.vessels.get(vesselId)
    if (!v || v.owner !== owner) return
    v.orbit = orbit
    v.flight = undefined
    v.status = status
    if (bodyId) v.bodyId = bodyId
    this.dirty = true
  }

  /** Award a milestone to a player once. Returns whether it was new and if they were first. */
  awardMilestone(playerId: string, kind: MilestoneKind): AwardResult | null {
    const p = this.players.get(playerId)
    const def = MILESTONES[kind]
    if (!p || !def) return null
    if (p.achieved.includes(kind)) return { newly: false, first: false, funds: 0, science: 0 }
    p.achieved.push(kind)
    p.funds += def.funds
    p.science += def.science
    const first = !this.firsts.has(kind)
    if (first) this.firsts.set(kind, playerId)
    this.dirty = true
    return { newly: true, first, funds: def.funds, science: def.science }
  }

  /** Recover a vessel; pays a recovery bonus if it reached space. Returns funds paid. */
  recover(vesselId: string, owner: string): number {
    const v = this.vessels.get(vesselId)
    if (!v || v.owner !== owner) return 0
    this.vessels.delete(vesselId)
    const p = this.players.get(owner)
    let paid = 0
    if (p && (v.status === 'orbit' || v.status === 'landed')) {
      paid = RECOVERY_FUNDS
      p.funds += paid
    }
    this.dirty = true
    return paid
  }

  private load(): Persisted | null {
    try {
      return JSON.parse(fs.readFileSync(this.stateFile, 'utf8')) as Persisted
    } catch {
      return null
    }
  }

  private flush(): void {
    if (!this.dirty) return
    const data: Persisted = {
      startWall: this.startWall,
      players: this.roster(),
      vessels: this.allVessels(),
      firsts: Object.fromEntries(this.firsts),
    }
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true })
      fs.writeFileSync(this.stateFile, JSON.stringify(data))
      this.dirty = false
    } catch (e) {
      console.error('[program] flush failed:', e)
    }
  }
}
