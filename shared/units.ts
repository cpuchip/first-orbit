// Units & 2D vector math — the shared numeric foundation.
// Everything is SI: metres, seconds, kilograms, newtons. The game world is
// scaled down (Kerbal-style ~1/10 of real bodies) so a hand-built rocket can
// reach orbit with a few thousand m/s of delta-v, but the maths is real.

export const G = 6.6743e-11 // gravitational constant, m^3 kg^-1 s^-2
export const G0 = 9.80665 // standard gravity, used for engine Isp -> exhaust velocity

export interface Vec2 {
  x: number
  y: number
}

export const vec = (x: number, y: number): Vec2 => ({ x, y })
export const ZERO: Vec2 = { x: 0, y: 0 }

export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y })
export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y })
export const scale = (a: Vec2, s: number): Vec2 => ({ x: a.x * s, y: a.y * s })
export const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y
// 2D "cross product" — the z component of the 3D cross. Sign = orbit direction.
export const cross = (a: Vec2, b: Vec2): number => a.x * b.y - a.y * b.x
export const len = (a: Vec2): number => Math.hypot(a.x, a.y)
export const len2 = (a: Vec2): number => a.x * a.x + a.y * a.y
export const dist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y)

export function norm(a: Vec2): Vec2 {
  const l = len(a)
  return l === 0 ? { x: 0, y: 0 } : { x: a.x / l, y: a.y / l }
}

// Rotate a vector by angle (radians, CCW).
export function rotate(a: Vec2, angle: number): Vec2 {
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  return { x: a.x * c - a.y * s, y: a.x * s + a.y * c }
}

// 90deg left rotation (perpendicular) — handy for tangential/prograde framing.
export const perp = (a: Vec2): Vec2 => ({ x: -a.y, y: a.x })

// Heading angle (radians) of a vector, measured CCW from +x.
export const angleOf = (a: Vec2): number => Math.atan2(a.y, a.x)

// Unit vector for a heading angle.
export const fromAngle = (angle: number, mag = 1): Vec2 => ({
  x: Math.cos(angle) * mag,
  y: Math.sin(angle) * mag,
})

// Wrap an angle to (-pi, pi].
export function wrapAngle(a: number): number {
  let x = a % (2 * Math.PI)
  if (x <= -Math.PI) x += 2 * Math.PI
  if (x > Math.PI) x -= 2 * Math.PI
  return x
}

export const TAU = Math.PI * 2
