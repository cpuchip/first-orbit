// Tech tiers — what science buys. Unlocking a tier costs science (spent), and a
// part is buildable once its tier is unlocked. Kept tiny and shared so the VAB
// and the server agree on what's available and what an unlock costs.

/** Science cost to unlock each tier (tier 0 is free from the start). */
export const TIER_COSTS = [0, 40, 150, 400]
export const MAX_TIER = TIER_COSTS.length - 1

export const TIER_NAMES = ['Sounding Rockets', 'Orbital Flight', 'Lunar Operations', 'Deep Space']

/** Science needed to unlock the given tier (Infinity past the last). */
export const tierCost = (tier: number): number => TIER_COSTS[tier] ?? Infinity

/** Is a part of `partTier` available to a player who has unlocked up to `playerTech`? */
export const partUnlocked = (partTier: number, playerTech: number): boolean => partTier <= playerTech
