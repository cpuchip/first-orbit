// Milestones — the progression spine, shared by client and server.
//
// The client detects when a vessel achieves a milestone and tells the server; the
// server awards funds + science (once per player) and broadcasts a "first to …"
// announcement to everyone. This is what turns a physics sandbox into a shared
// space program with stakes — and the multiplayer bragging rights.

export type MilestoneKind =
  | 'launch'
  | 'orbit'
  | 'luna_soi'
  | 'luna_orbit'
  | 'luna_landing'
  | 'return'

export interface MilestoneDef {
  kind: MilestoneKind
  label: string
  blurb: string
  funds: number
  science: number
}

export const MILESTONES: Record<MilestoneKind, MilestoneDef> = {
  launch: { kind: 'launch', label: 'First Flight', blurb: 'left the launch pad', funds: 500, science: 2 },
  orbit: { kind: 'orbit', label: 'Reach Orbit', blurb: 'reached a stable orbit around Terra', funds: 5_000, science: 10 },
  luna_soi: { kind: 'luna_soi', label: 'Luna Flyby', blurb: 'entered Luna’s sphere of influence', funds: 8_000, science: 25 },
  luna_orbit: { kind: 'luna_orbit', label: 'Lunar Orbit', blurb: 'reached a stable orbit around Luna', funds: 10_000, science: 40 },
  luna_landing: { kind: 'luna_landing', label: 'The Eagle Has Landed', blurb: 'landed on Luna', funds: 20_000, science: 80 },
  return: { kind: 'return', label: 'Safe Return', blurb: 'returned safely to Terra from space', funds: 6_000, science: 15 },
}

export const MILESTONE_ORDER: MilestoneKind[] = ['launch', 'orbit', 'luna_soi', 'luna_orbit', 'luna_landing', 'return']

/** Recovery value paid when a player recovers a vessel that reached space. */
export const RECOVERY_FUNDS = 2_000
