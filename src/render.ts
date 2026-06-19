// Canvas renderer — flight view and orbital map.
//
// Flight view auto-zooms with altitude: the home world is drawn at true scale, so
// it fills the screen as "ground" on the pad and naturally shrinks into a planet
// as you climb — no separate art needed, the curvature is real. The map view
// draws the analytic orbits the whole simulation is built on.

import { SYSTEM, ROOT, bodyPosition, type Body } from '../shared/bodies.ts'
import { elementsToState, orbitPath, apsides } from '../shared/orbit.ts'
import { nodeState } from '../shared/maneuver.ts'
import { type Vec2, vec, add, scale, fromAngle, len } from '../shared/units.ts'
import type { Game } from './game.ts'
import type { VesselState, PlayerInfo } from '../shared/netproto.ts'

const ROOT_BODY = SYSTEM[ROOT]

// A fixed starfield (screen-space parallax-free is fine for this scale).
const STARS = Array.from({ length: 220 }, () => ({
  x: Math.random(),
  y: Math.random(),
  b: 0.3 + Math.random() * 0.7,
}))

function drawStars(ctx: CanvasRenderingContext2D, w: number, h: number, alpha: number): void {
  if (alpha <= 0) return
  ctx.save()
  for (const s of STARS) {
    ctx.globalAlpha = s.b * alpha
    ctx.fillStyle = '#fff'
    ctx.fillRect(s.x * w, s.y * h, 1.5, 1.5)
  }
  ctx.restore()
}

/** World position of a vessel in the root frame at a given universe time. */
export function vesselWorldPos(v: VesselState, universeTime: number): Vec2 | null {
  if (v.orbit) return add(elementsToState(v.orbit, universeTime).pos, bodyPosition(SYSTEM, v.bodyId, universeTime))
  if (v.flight) return vec(v.flight.x, v.flight.y)
  return null
}

// Eased display positions, so other players' active flights glide between the
// 10 Hz server snapshots instead of teleporting. Coasting vessels are analytic
// (already smooth) so they snap exactly.
const displayPos = new Map<string, Vec2>()
export function vesselDisplayPos(v: VesselState, universeTime: number): Vec2 | null {
  const target = vesselWorldPos(v, universeTime)
  if (!target) return null
  if (v.flight) {
    const cur = displayPos.get(v.id)
    const next = cur ? { x: cur.x + (target.x - cur.x) * 0.25, y: cur.y + (target.y - cur.y) * 0.25 } : { ...target }
    displayPos.set(v.id, next)
    return next
  }
  displayPos.set(v.id, target)
  return target
}

// ---- flight view ---------------------------------------------------------------
export function drawFlight(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  game: Game,
  vessels: VesselState[] = [],
  players: PlayerInfo[] = [],
  universeTime = 0,
): void {
  const st = game.st
  const r = game.readout()
  const alt = r.altitude

  // Auto framing: ~1.5 km of view on the pad, widening with altitude.
  const span = Math.max(1500, Math.min(alt * 3 + 1500, 6_000_000))
  const s = h / span // px per metre
  const center = st.pos
  const toScreen = (p: Vec2): Vec2 => vec(w / 2 + (p.x - center.x) * s, h / 2 - (p.y - center.y) * s)

  // Sky: fades from blue at sea level to black above the atmosphere.
  const atmo = ROOT_BODY.atmosphere?.height ?? 1
  const skyT = Math.max(0, Math.min(1, alt / atmo))
  const top = `rgb(${Math.round(8 + 4 * (1 - skyT))},${Math.round(10 + 8 * (1 - skyT))},${Math.round(20 + 30 * (1 - skyT))})`
  const grad = ctx.createLinearGradient(0, 0, 0, h)
  grad.addColorStop(0, '#05060a')
  grad.addColorStop(1, top)
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, w, h)
  drawStars(ctx, w, h, skyT)

  // Every body, true scale — so the home world is "ground" on the pad and Luna
  // fills the view on a landing approach, with no special-casing.
  for (const b of Object.values(SYSTEM) as Body[]) {
    const bc = toScreen(bodyPosition(SYSTEM, b.id, st.t))
    const br = b.radius * s
    if (br < 0.5 && Math.hypot(bc.x - w / 2, bc.y - h / 2) > Math.hypot(w, h)) continue
    ctx.beginPath()
    ctx.arc(bc.x, bc.y, br, 0, Math.PI * 2)
    ctx.fillStyle = b.color
    ctx.fill()
    if (b.atmosphere) {
      ctx.beginPath()
      ctx.arc(bc.x, bc.y, (b.radius + b.atmosphere.height) * s, 0, Math.PI * 2)
      ctx.strokeStyle = 'rgba(120,170,255,0.25)'
      ctx.lineWidth = 1
      ctx.stroke()
    }
  }

  // Other players nearby — rendezvous presence.
  const colors = new Map(players.map((p) => [p.id, p.color]))
  for (const v of vessels) {
    if (v.id === game.vesselId) continue
    const p = vesselDisplayPos(v, universeTime)
    if (!p) continue
    const sc = toScreen(p)
    if (sc.x < -30 || sc.x > w + 30 || sc.y < -30 || sc.y > h + 30) continue
    const col = colors.get(v.owner) ?? '#888'
    ctx.fillStyle = col
    ctx.beginPath()
    ctx.moveTo(sc.x, sc.y - 6)
    ctx.lineTo(sc.x + 5, sc.y + 5)
    ctx.lineTo(sc.x - 5, sc.y + 5)
    ctx.closePath()
    ctx.fill()
    ctx.fillStyle = 'rgba(255,255,255,0.75)'
    ctx.font = '10px system-ui, sans-serif'
    ctx.fillText(`${v.name} · ${v.ownerName}`, sc.x + 8, sc.y)
  }

  drawVessel(ctx, toScreen(st.pos), st.heading, s, r.throttle, r.fuel > 0)

  // Prograde marker.
  if (len(st.vel) > 5) {
    const pg = add(toScreen(st.pos), scale(fromAngle(Math.atan2(st.vel.y, st.vel.x)), 42))
    ctx.strokeStyle = '#f1c40f'
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.arc(pg.x, pg.y, 6, 0, Math.PI * 2)
    ctx.moveTo(pg.x - 9, pg.y)
    ctx.lineTo(pg.x - 6, pg.y)
    ctx.moveTo(pg.x + 9, pg.y)
    ctx.lineTo(pg.x + 6, pg.y)
    ctx.stroke()
  }
}

function drawVessel(ctx: CanvasRenderingContext2D, p: Vec2, heading: number, s: number, throttle: number, hasFuel: boolean): void {
  // Vehicle is ~12 m tall; clamp to a visible minimum as the view zooms out.
  const sizePx = Math.max(10, 12 * s)
  ctx.save()
  ctx.translate(p.x, p.y)
  ctx.rotate(-heading + Math.PI / 2) // heading 0 = +x; sprite drawn nose-up
  // exhaust
  if (throttle > 0 && hasFuel) {
    const flame = sizePx * (0.8 + throttle * 1.4)
    const fg = ctx.createLinearGradient(0, sizePx * 0.5, 0, sizePx * 0.5 + flame)
    fg.addColorStop(0, 'rgba(255,220,120,0.95)')
    fg.addColorStop(1, 'rgba(255,80,30,0)')
    ctx.fillStyle = fg
    ctx.beginPath()
    ctx.moveTo(-sizePx * 0.18, sizePx * 0.5)
    ctx.lineTo(sizePx * 0.18, sizePx * 0.5)
    ctx.lineTo(0, sizePx * 0.5 + flame)
    ctx.closePath()
    ctx.fill()
  }
  // body
  ctx.fillStyle = '#dfe3e8'
  ctx.fillRect(-sizePx * 0.16, -sizePx * 0.5, sizePx * 0.32, sizePx)
  // nose
  ctx.fillStyle = '#c0392b'
  ctx.beginPath()
  ctx.moveTo(-sizePx * 0.16, -sizePx * 0.5)
  ctx.lineTo(sizePx * 0.16, -sizePx * 0.5)
  ctx.lineTo(0, -sizePx * 0.85)
  ctx.closePath()
  ctx.fill()
  // fins
  ctx.fillStyle = '#8a8f95'
  ctx.beginPath()
  ctx.moveTo(-sizePx * 0.16, sizePx * 0.5)
  ctx.lineTo(-sizePx * 0.34, sizePx * 0.5)
  ctx.lineTo(-sizePx * 0.16, sizePx * 0.2)
  ctx.closePath()
  ctx.fill()
  ctx.beginPath()
  ctx.moveTo(sizePx * 0.16, sizePx * 0.5)
  ctx.lineTo(sizePx * 0.34, sizePx * 0.5)
  ctx.lineTo(sizePx * 0.16, sizePx * 0.2)
  ctx.closePath()
  ctx.fill()
  ctx.restore()
}

// ---- orbital map ---------------------------------------------------------------
export function drawMap(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  game: Game,
  vessels: VesselState[],
  players: PlayerInfo[],
  universeTime: number,
  zoom: number,
): void {
  ctx.fillStyle = '#05060a'
  ctx.fillRect(0, 0, w, h)
  drawStars(ctx, w, h, 1)

  // Fit Luna's orbit, scaled by the player's zoom.
  const fit = (SYSTEM['luna'].orbitRadius ?? 1_000_000) * 1.25
  const s = ((Math.min(w, h) / 2) / fit) * zoom
  const center = vec(0, 0) // Terra-centred
  const toScreen = (p: Vec2): Vec2 => vec(w / 2 + (p.x - center.x) * s, h / 2 - (p.y - center.y) * s)

  const playerColor = new Map(players.map((p) => [p.id, p.color]))

  // Bodies.
  for (const b of Object.values(SYSTEM) as Body[]) {
    const bp = bodyPosition(SYSTEM, b.id, universeTime)
    const sc = toScreen(bp)
    // Orbit ring for child bodies.
    if (b.parent && b.orbitRadius) {
      const pp = toScreen(bodyPosition(SYSTEM, b.parent, universeTime))
      ctx.beginPath()
      ctx.arc(pp.x, pp.y, b.orbitRadius * s, 0, Math.PI * 2)
      ctx.strokeStyle = 'rgba(255,255,255,0.12)'
      ctx.lineWidth = 1
      ctx.stroke()
    }
    ctx.beginPath()
    ctx.arc(sc.x, sc.y, Math.max(3, b.radius * s), 0, Math.PI * 2)
    ctx.fillStyle = b.color
    ctx.fill()
    ctx.fillStyle = 'rgba(255,255,255,0.7)'
    ctx.font = '11px system-ui, sans-serif'
    ctx.fillText(b.name, sc.x + Math.max(5, b.radius * s) + 3, sc.y + 3)
  }

  // The player's own orbit, drawn around whichever body it's bound to.
  const el = game.elements()
  const pBodyPos = bodyPosition(SYSTEM, game.currentBody(), universeTime)
  if (el.e < 1) {
    const path = orbitPath(el, 160)
    ctx.beginPath()
    path.forEach((p, i) => {
      const sc = toScreen(add(p, pBodyPos))
      if (i === 0) ctx.moveTo(sc.x, sc.y)
      else ctx.lineTo(sc.x, sc.y)
    })
    ctx.strokeStyle = 'rgba(46,204,113,0.7)'
    ctx.lineWidth = 1.5
    ctx.stroke()
    // Apo/peri markers (relative to the orbit's periapsis direction).
    const { apoapsis, periapsis } = apsides(el)
    label(ctx, toScreen(add(scale(fromAngle(el.argPe), periapsis), pBodyPos)), 'Pe')
    if (apoapsis < Infinity) label(ctx, toScreen(add(scale(fromAngle(el.argPe + Math.PI), apoapsis), pBodyPos)), 'Ap')
  }

  // Maneuver node: the planned orbit (dashed gold) + the burn marker.
  const planned = game.plannedElements()
  if (game.node) {
    if (planned && planned.e < 1) {
      const path = orbitPath(planned, 160)
      ctx.setLineDash([6, 5])
      ctx.beginPath()
      path.forEach((p, i) => {
        const sc = toScreen(add(p, pBodyPos))
        if (i === 0) ctx.moveTo(sc.x, sc.y)
        else ctx.lineTo(sc.x, sc.y)
      })
      ctx.strokeStyle = 'rgba(241,196,15,0.85)'
      ctx.lineWidth = 1.5
      ctx.stroke()
      ctx.setLineDash([])
    }
    const ns = nodeState(el, game.node)
    const nsc = toScreen(add(ns.pos, pBodyPos))
    ctx.fillStyle = '#f1c40f'
    ctx.beginPath()
    ctx.arc(nsc.x, nsc.y, 5, 0, Math.PI * 2)
    ctx.fill()
    ctx.strokeStyle = '#f1c40f'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.arc(nsc.x, nsc.y, 9, 0, Math.PI * 2)
    ctx.stroke()
  }

  // Other players' vessels (propagated by their analytic orbit / last flight snap).
  for (const v of vessels) {
    if (v.id === game.vesselId) continue // our own is drawn live, below
    const p = vesselDisplayPos(v, universeTime)
    if (!p) continue
    const sc = toScreen(p)
    mark(ctx, sc, playerColor.get(v.owner) ?? '#888')
    ctx.fillStyle = 'rgba(255,255,255,0.65)'
    ctx.font = '10px system-ui, sans-serif'
    ctx.fillText(`${v.name} · ${v.ownerName}`, sc.x + 7, sc.y - 6)
  }

  // Our own vessel — drawn from the live local state (most accurate).
  if (game.vesselId) {
    const sc = toScreen(game.st.pos)
    mark(ctx, sc, '#2ecc71')
    ctx.fillStyle = '#2ecc71'
    ctx.font = '10px system-ui, sans-serif'
    ctx.fillText('you', sc.x + 7, sc.y - 6)
  }
}

function mark(ctx: CanvasRenderingContext2D, p: Vec2, color: string): void {
  ctx.fillStyle = color
  ctx.beginPath()
  ctx.arc(p.x, p.y, 4, 0, Math.PI * 2)
  ctx.fill()
}
function label(ctx: CanvasRenderingContext2D, p: Vec2, text: string): void {
  ctx.fillStyle = 'rgba(255,255,255,0.5)'
  ctx.font = '10px system-ui, sans-serif'
  ctx.fillText(text, p.x + 4, p.y)
}
