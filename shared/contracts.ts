// Contracts — competitive objectives the whole room races for. Unlike milestones
// (which every player can earn once), a contract is claimed by the FIRST player to
// meet it, then it's gone. Think comsat constellations, lunar surveys, boots on
// the Moon — with funds + science on the line.

export type ContractKind = 'terra_orbit' | 'body_orbit' | 'land'

export interface ContractDef {
  id: string
  title: string
  blurb: string
  funds: number
  science: number
  kind: ContractKind
  body?: string
  minAlt?: number // m, periapsis above
  maxAlt?: number // m
}

export const CONTRACTS: ContractDef[] = [
  { id: 'comsat-low', title: 'Comsat — Low Band', blurb: 'Park a satellite in a stable Terra orbit 200–2,000 km up', funds: 12_000, science: 15, kind: 'terra_orbit', body: 'terra', minAlt: 200_000, maxAlt: 2_000_000 },
  { id: 'comsat-high', title: 'Comsat — High Band', blurb: 'A stable Terra orbit above 5,000 km (relay altitude)', funds: 22_000, science: 30, kind: 'terra_orbit', body: 'terra', minAlt: 5_000_000 },
  { id: 'luna-survey', title: 'Lunar Survey', blurb: 'Reach a stable orbit around Luna', funds: 26_000, science: 50, kind: 'body_orbit', body: 'luna' },
  { id: 'luna-boots', title: 'Boots on Luna', blurb: 'Land a crew on Luna', funds: 45_000, science: 95, kind: 'land', body: 'luna' },
]

export const contractDef = (id: string): ContractDef | undefined => CONTRACTS.find((c) => c.id === id)

export interface ContractContext {
  bodyId: string
  inOrbit: boolean
  periapsisAlt: number
  landed: boolean
}

/** Does the vessel's current state satisfy the contract? */
export function contractMet(c: ContractDef, ctx: ContractContext): boolean {
  switch (c.kind) {
    case 'terra_orbit':
      return ctx.bodyId === 'terra' && ctx.inOrbit && ctx.periapsisAlt >= (c.minAlt ?? 0) && ctx.periapsisAlt <= (c.maxAlt ?? Infinity)
    case 'body_orbit':
      return ctx.bodyId === c.body && ctx.inOrbit
    case 'land':
      return ctx.bodyId === c.body && ctx.landed
  }
}
