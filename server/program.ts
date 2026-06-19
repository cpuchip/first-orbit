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

const COLORS = ['#e74c3c', '#3498db', '#2ecc71', '#f1c40f', '#9b59b6', '#1abc9c', '#e67e22', '#ecf0f1']

interface Persisted {
  startWall: number
  players: PlayerInfo[]
  vessels: VesselState[]
}

export class Program {
  private startWall: number
  private players = new Map<string, PlayerInfo>()
  private vessels = new Map<string, VesselState>()
  private stateFile: string
  private dirty = false

  constructor(stateDir: string) {
    this.stateFile = path.join(stateDir, 'program.json')
    const loaded = this.load()
    this.startWall = loaded?.startWall ?? Date.now()
    for (const p of loaded?.players ?? []) this.players.set(p.id, p)
    for (const v of loaded?.vessels ?? []) this.vessels.set(v.id, v)
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
  settle(vesselId: string, owner: string, orbit: VesselState['orbit'], status: VesselState['status']): void {
    const v = this.vessels.get(vesselId)
    if (!v || v.owner !== owner) return
    v.orbit = orbit
    v.flight = undefined
    v.status = status
    this.dirty = true
  }

  recover(vesselId: string, owner: string): void {
    const v = this.vessels.get(vesselId)
    if (!v || v.owner !== owner) return
    this.vessels.delete(vesselId)
    this.dirty = true
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
    const data: Persisted = { startWall: this.startWall, players: this.roster(), vessels: this.allVessels() }
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true })
      fs.writeFileSync(this.stateFile, JSON.stringify(data))
      this.dirty = false
    } catch (e) {
      console.error('[program] flush failed:', e)
    }
  }
}
