<script lang="ts">
  import { onMount } from 'svelte'
  import { Net } from './net.ts'
  import { Game } from './game.ts'
  import { drawFlight, drawMap, mapScale, vesselWorldPos } from './render.ts'
  import { referenceRocket, performance as stagePerformance, totalDeltaV, totalMass, vehicleCost } from '../shared/vehicle.ts'
  import { PARTS } from '../shared/parts.ts'
  import { tierCost, TIER_NAMES, MAX_TIER } from '../shared/tech.ts'
  import { SYSTEM, ROOT, surfaceGravity, bodyPosition, bodyVelocity } from '../shared/bodies.ts'
  import { elementsToState, apsides } from '../shared/orbit.ts'
  import type { PlayerInfo, VesselState, ServerMsg, ContractState } from '../shared/netproto.ts'
  import { MILESTONES, MILESTONE_ORDER } from '../shared/milestones.ts'
  import { CONTRACTS, contractDef, contractMet } from '../shared/contracts.ts'
  import { type DebrisDef, debrisState, debrisDef, SALVAGE_RANGE, SALVAGE_SPEED } from '../shared/debris.ts'

  const BUILD = __BUILD_SHA__
  const terra = SYSTEM[ROOT]

  // 'menu' = title; 'observe' = connected, watching the map/your fleet, not flying;
  // 'flight' = piloting a craft. The Assembly (showVab) is an overlay you can open
  // and close anytime over observe or flight.
  let screen = $state<'menu' | 'observe' | 'flight'>('menu')
  let showVab = $state(false)
  let launching = $state(false) // true between clicking Launch and the server confirming the vessel
  let view = $state<'flight' | 'map'>('flight')
  let callsign = $state(localStorage.getItem('fo-callsign') ?? '')
  let roomCode = $state(localStorage.getItem('fo-room') ?? '')
  let currentRoom = $state('frontier')
  let connected = $state(false)
  let players = $state<PlayerInfo[]>([])
  let vessels = $state<VesselState[]>([])
  let contracts = $state<ContractState[]>([])
  let debris = $state<DebrisDef[]>([])
  const claimAttempts = new Set<string>()
  let chat = $state<{ from: string; color: string; text: string }[]>([])
  let chatInput = $state('')
  let mapZoom = $state(1)
  let mapCenter = $state({ x: 0, y: 0 })
  let mapFollow = $state(false)
  let flightZoom = $state(1)
  let pipMapZoom = $state(0.85)
  let pipFlightZoom = $state(1)
  let showPip = $state(true)
  let hud = $state<ReturnType<Game['readout']> | null>(null)
  let nodeInfo = $state<ReturnType<Game['nodeReadout']>>(null)
  let you = $state<PlayerInfo | null>(null)
  let toasts = $state<{ id: number; text: string; color: string; first: boolean }[]>([])
  let toastSeq = 0
  let showBoard = $state(true)
  let showHelp = $state(false)
  let showMenu = $state(false)
  let showFleet = $state(false)
  let paused = $state(false)
  const myFleet = $derived(vessels.filter((v) => v.owner === you?.id))
  function fleetInfo(v: VesselState): string {
    const b = SYSTEM[v.bodyId] ?? SYSTEM[ROOT]
    if (v.status === 'landed') return `landed on ${b.name}`
    if (v.status === 'flight') return `in flight near ${b.name}`
    if (v.orbit) {
      const ap = apsides(v.orbit)
      const pa = Math.round((ap.periapsis - b.radius) / 1000)
      const aa = ap.apoapsis === Infinity ? '∞' : Math.round((ap.apoapsis - b.radius) / 1000)
      return `${b.name} orbit · ${pa}×${aa} km`
    }
    return v.status
  }
  function locate(v: VesselState) {
    const t = screen === 'flight' ? game.st.t : universeTime()
    const s = objectState('vessel', v.id, t)
    if (!s) return
    if (screen !== 'flight') screen = 'observe'
    view = 'map'
    mapCenter = { x: s.pos.x, y: s.pos.y }
    mapFollow = v.id === game.vesselId
    mapZoom = v.bodyId === ROOT ? 18 : 40
    showFleet = false
    showVab = false
  }
  function recoverVessel(v: VesselState) {
    if (v.id === game.vesselId) { showFleet = false; recover(); return } // your active craft → back to the VAB
    net.send({ type: 'recover', vesselId: v.id }) // an abandoned craft → just bring it home for funds
  }
  function flyVessel(v: VesselState) {
    if (game.resumeVessel(v, universeTime())) {
      view = 'flight'
      screen = 'flight'
      showFleet = false
      pushToast(`Now flying ${v.name}.`, '#2ecc71')
    } else {
      pushToast('That craft can’t be re-piloted — it was built before resume existed.', '#e57373')
    }
  }
  const isPrivate = $derived(currentRoom !== 'frontier')
  function quitToMenu() {
    net.disconnect()
    game.vesselId = ''
    paused = false
    showMenu = false
    connected = false
    screen = 'menu'
  }
  const achieved = $derived(you?.achieved ?? [])
  const nextObjective = $derived(MILESTONE_ORDER.find((k) => !achieved.includes(k)) ?? null)
  function dismissHelp() {
    showHelp = false
    try { localStorage.setItem('fo-helped', '1') } catch { /* private mode */ }
  }
  function pushToast(text: string, color = '#7fb0ff') {
    const id = ++toastSeq
    toasts = [...toasts, { id, text, color, first: false }]
    setTimeout(() => { toasts = toasts.filter((t) => t.id !== id) }, 8000)
  }
  const swapView = () => (view = view === 'flight' ? 'map' : 'flight')
  function onPipWheel(e: WheelEvent) {
    e.preventDefault()
    const f = e.deltaY < 0 ? 1.15 : 1 / 1.15
    if (view === 'flight') pipMapZoom = Math.max(0.15, Math.min(40, pipMapZoom * f))
    else pipFlightZoom = Math.max(0.15, Math.min(12, pipFlightZoom * f))
  }
  function planTransfer() {
    if (game.target?.kind !== 'body') return
    const s = game.planTransferTo(game.target.id)
    pushToast(s ?? `Get into a near-circular orbit around ${hud?.bodyName ?? 'the planet'} first, then plan the transfer.`, s ? '#2ecc71' : '#e57373')
  }
  const salvageReady = $derived(
    hud?.targetKind === 'debris' && hud.targetDist != null && hud.targetDist <= SALVAGE_RANGE && (hud.targetRelSpeed ?? 1e9) <= SALVAGE_SPEED,
  )
  function salvageTarget() {
    if (game.target?.kind === 'debris' && salvageReady) net.send({ type: 'salvage', id: game.target.id })
  }
  function circularize() {
    const s = game.planCircularize()
    if (s === 'already') pushToast('That orbit is already circular.', '#7fb0ff')
    else if (s) pushToast(s, '#2ecc71')
    else pushToast('Get into a stable orbit first — reach apoapsis above the atmosphere.', '#e57373')
  }

  // Universe clock, anchored to the last server time we heard.
  let serverTime = 0
  let serverStamp = 0
  const universeTime = () => serverTime + (performanceNow() - serverStamp) / 1000
  const performanceNow = () => window.performance.now()

  const net = new Net()
  const game = new Game()
  game.send = (m) => net.send(m)
  game.onMilestone = (kind) => {
    if (game.vesselId) net.send({ type: 'milestone', vesselId: game.vesselId, kind })
  }

  let canvas: HTMLCanvasElement
  let ctx: CanvasRenderingContext2D
  let pipCanvas: HTMLCanvasElement
  let pipCtx: CanvasRenderingContext2D | null = null

  // --- Vehicle Assembly: an editable, persisted rocket design ---------------
  type StageDesign = { engine: 'none' | 'main' | 'vac'; engineCount: number; tanks: number; tankSize: 'small' | 'large'; fins: boolean }
  type Design = { name: string; stages: StageDesign[]; crew?: 'pod' | 'lander'; parachute?: boolean; legs?: boolean }
  const PRESETS: Record<string, Design> = {
    Sounding: { name: 'Sounding I', crew: 'pod', stages: [{ engine: 'main', engineCount: 1, tanks: 1, tankSize: 'small', fins: true }] },
    Orbiter: { name: 'Pathfinder I', crew: 'pod', stages: [{ engine: 'main', engineCount: 1, tanks: 1, tankSize: 'large', fins: true }, { engine: 'vac', engineCount: 1, tanks: 1, tankSize: 'small', fins: false }] },
    Munar: { name: 'Selene I', crew: 'lander', legs: true, parachute: true, stages: [{ engine: 'main', engineCount: 3, tanks: 2, tankSize: 'large', fins: true }, { engine: 'main', engineCount: 1, tanks: 1, tankSize: 'large', fins: false }, { engine: 'vac', engineCount: 1, tanks: 2, tankSize: 'small', fins: false }] },
  }
  const defaultDesign = (): Design => structuredClone(PRESETS.Orbiter)
  function loadDesign(): Design | null {
    try {
      const d = JSON.parse(localStorage.getItem('fo-design') || 'null')
      return d && Array.isArray(d.stages) && d.stages.length ? d : null
    } catch {
      return null
    }
  }
  let design = $state<Design>(loadDesign() ?? defaultDesign())
  const g = surfaceGravity(terra)

  function buildVehicle(d: Design) {
    const stages = d.stages.map((s, i) => {
      const ids: string[] = []
      const ec = Math.max(0, s.engineCount ?? 1)
      if (s.engine !== 'none') for (let e = 0; e < ec; e++) ids.push(s.engine === 'main' ? 'engine-main' : 'engine-vac')
      for (let t = 0; t < s.tanks; t++) ids.push(s.tankSize === 'large' ? 'tank-large' : 'tank-small')
      if (s.fins) ids.push('fin', 'fin')
      if (i < d.stages.length - 1) ids.push('decoupler') // separates this stage from the one above
      if (i === d.stages.length - 1) {
        ids.push(d.crew === 'lander' ? 'lander' : 'cmd-pod') // crew module rides the top stage
        if (d.parachute) ids.push('parachute')
        if (d.legs) ids.push('leg', 'leg', 'leg')
      }
      return { partIds: ids }
    })
    return { name: d.name || 'Unnamed', stages }
  }
  let vehicle = $derived(buildVehicle(design))
  let perf = $derived(stagePerformance(vehicle))
  let vabDv = $derived(Math.round(totalDeltaV(vehicle)))
  let vabMass = $derived((totalMass(vehicle) / 1000).toFixed(1))
  let vabCost = $derived(vehicleCost(vehicle))
  const youTech = $derived(you?.tech ?? 0)
  const youFunds = $derived(you?.funds ?? 0)
  const canAfford = $derived(youFunds >= vabCost)
  // A design that uses parts above your tech tier can't be built.
  const buildable = $derived(vehicle.stages.every((s) => s.partIds.every((id) => (PARTS[id].tier ?? 0) <= youTech)))
  function unlockNextTier() {
    if (youTech < MAX_TIER && (you?.science ?? 0) >= tierCost(youTech + 1)) net.send({ type: 'unlock_tech', tier: youTech + 1 })
  }
  const setCrew = (c: 'pod' | 'lander') => (design.crew = c)
  const toggleParachute = () => (design.parachute = !design.parachute)
  const toggleLegs = () => (design.legs = !design.legs)
  $effect(() => {
    try { localStorage.setItem('fo-design', JSON.stringify(design)) } catch { /* private mode */ }
  })

  const setEngine = (i: number, e: StageDesign['engine']) => (design.stages[i].engine = e)
  const addEngine = (i: number, d: number) => (design.stages[i].engineCount = Math.max(1, Math.min(6, (design.stages[i].engineCount ?? 1) + d)))
  const addTank = (i: number, d: number) => (design.stages[i].tanks = Math.max(0, Math.min(8, design.stages[i].tanks + d)))
  const setTankSize = (i: number, sz: StageDesign['tankSize']) => (design.stages[i].tankSize = sz)
  const toggleFins = (i: number) => (design.stages[i].fins = !design.stages[i].fins)
  function addStage() {
    if (design.stages.length < 5) design.stages = [{ engine: 'main', tanks: 1, tankSize: 'large', fins: false }, ...design.stages]
  }
  const removeStage = (i: number) => { if (design.stages.length > 1) design.stages = design.stages.filter((_, j) => j !== i) }
  const applyPreset = (name: keyof typeof PRESETS) => (design = structuredClone(PRESETS[name]))
  let pendingVehicle = referenceRocket()

  net.on((msg: ServerMsg) => {
    switch (msg.type) {
      case 'welcome':
        connected = true
        players = msg.players
        vessels = msg.vessels
        you = msg.you
        currentRoom = msg.room
        contracts = msg.contracts
        debris = msg.debris
        serverTime = msg.universeTime
        serverStamp = performanceNow()
        // A brand-new program (no craft aloft yet) opens straight into the Assembly;
        // a returning pilot lands on the map looking at their fleet.
        if (screen === 'observe') showVab = msg.vessels.every((v) => v.ownerName !== msg.you.name)
        break
      case 'players':
        players = msg.players
        you = msg.players.find((p) => p.id === you?.id) ?? you
        break
      case 'achievement': {
        const def = MILESTONES[msg.kind]
        const id = ++toastSeq
        const text = msg.first
          ? `★ ${msg.playerName} was FIRST to ${def.blurb}!`
          : `${msg.playerName} ${def.blurb}.`
        toasts = [...toasts, { id, text, color: msg.color, first: msg.first }]
        setTimeout(() => { toasts = toasts.filter((t) => t.id !== id) }, 7000)
        break
      }
      case 'snapshot':
        vessels = msg.vessels
        serverTime = msg.universeTime
        serverStamp = performanceNow()
        break
      case 'vesselCreated':
        vessels = [...vessels, msg.vessel]
        if (msg.vessel.ownerName === callsign && launching) {
          launching = false
          game.launch(pendingVehicle, msg.vessel.id, universeTime())
          showVab = false
          screen = 'flight'
          view = 'flight'
          try { if (!localStorage.getItem('fo-helped')) showHelp = true } catch { /* private mode */ }
        }
        break
      case 'contracts':
        contracts = msg.contracts
        break
      case 'contract_claimed': {
        const def = contractDef(msg.id)
        pushToast(`${msg.playerName} claimed “${def?.title ?? msg.id}” — +⬡${msg.funds.toLocaleString()} +⚛${msg.science}`, '#f1c40f')
        break
      }
      case 'debris':
        debris = msg.debris
        break
      case 'salvaged':
        pushToast(`${msg.playerName} salvaged the ${msg.name} — +⬡${msg.funds.toLocaleString()} +⚛${msg.science}`, '#f1c40f')
        if (game.target?.kind === 'debris' && game.target.id === msg.id) game.setTarget(null)
        break
      case 'chat':
        chat = [...chat.slice(-40), { from: msg.from, color: msg.color, text: msg.text }]
        break
      case 'error':
        console.warn('server:', msg.message)
        break
    }
  })

  function enter() {
    const name = callsign.trim()
    if (!name) return
    callsign = name
    const room = roomCode.trim().toLowerCase().replace(/[^a-z0-9-]/g, '') || 'frontier'
    try {
      localStorage.setItem('fo-callsign', name)
      localStorage.setItem('fo-room', roomCode.trim())
    } catch { /* private mode */ }
    net.connect(name, room)
    screen = 'observe'
    view = 'map'
    // The welcome handler opens the Assembly automatically for a brand-new program.
  }
  function openVab() { showVab = true; showFleet = false }
  function closeVab() { showVab = false }

  function launch() {
    if (!buildable) return pushToast('This design uses parts you haven’t unlocked yet — see Tech.', '#e57373')
    if (!canAfford) return pushToast(`Not enough funds — this rocket costs ⬡${vabCost.toLocaleString()}, you have ⬡${youFunds.toLocaleString()}.`, '#e57373')
    pendingVehicle = buildVehicle(design)
    launching = true
    net.send({ type: 'launch', vesselName: design.name.trim() || 'Unnamed', bodyId: ROOT, cost: vabCost, vehicle: { stages: pendingVehicle.stages } })
  }

  function recover() {
    if (game.vesselId) net.send({ type: 'recover', vesselId: game.vesselId })
    game.vesselId = ''
    screen = 'observe'
    view = 'map'
  }

  // World position + velocity of a targetable object at universe time t.
  function objectState(kind: 'vessel' | 'body' | 'debris', id: string, t: number): { pos: { x: number; y: number }; vel: { x: number; y: number } } | null {
    if (kind === 'body') return { pos: bodyPosition(SYSTEM, id, t), vel: bodyVelocity(SYSTEM, id, t) }
    if (kind === 'debris') { const d = debrisDef(id); return d ? debrisState(d, t) : null }
    const v = vessels.find((x) => x.id === id)
    if (!v) return null
    if (v.orbit) {
      const s = elementsToState(v.orbit, t)
      const bp = bodyPosition(SYSTEM, v.bodyId, t)
      const bv = bodyVelocity(SYSTEM, v.bodyId, t)
      return { pos: { x: s.pos.x + bp.x, y: s.pos.y + bp.y }, vel: { x: s.vel.x + bv.x, y: s.vel.y + bv.y } }
    }
    if (v.flight) return { pos: { x: v.flight.x, y: v.flight.y }, vel: { x: v.flight.vx, y: v.flight.vy } }
    return null
  }

  // Right-click on the map picks the nearest body/vessel as the target (or clears it).
  function pickTarget(clientX: number, clientY: number) {
    if (view !== 'map' || screen !== 'flight') return
    const rect = canvas.getBoundingClientRect()
    const sx = clientX - rect.left
    const sy = clientY - rect.top
    const t = game.st.t // match the render clock (the map draws on the ship's clock, not wall time)
    const s = mapScale(canvas.width, canvas.height, mapZoom)
    const toScreen = (p: { x: number; y: number }) => ({ x: canvas.width / 2 + (p.x - mapCenter.x) * s, y: canvas.height / 2 - (p.y - mapCenter.y) * s })
    let best: { kind: 'vessel' | 'body' | 'debris'; id: string; name: string } | null = null
    let bestD = 26
    for (const b of Object.values(SYSTEM)) {
      const sc = toScreen(bodyPosition(SYSTEM, b.id, t))
      const d = Math.hypot(sc.x - sx, sc.y - sy)
      if (d < bestD) { bestD = d; best = { kind: 'body', id: b.id, name: b.name } }
    }
    for (const dz of debris) {
      const sc = toScreen(debrisState(dz, t).pos)
      const d = Math.hypot(sc.x - sx, sc.y - sy)
      if (d < bestD) { bestD = d; best = { kind: 'debris', id: dz.id, name: dz.name } }
    }
    for (const v of vessels) {
      if (v.id === game.vesselId) continue
      const p = vesselWorldPos(v, t)
      if (!p) continue
      const sc = toScreen(p)
      const d = Math.hypot(sc.x - sx, sc.y - sy)
      if (d < bestD) { bestD = d; best = { kind: 'vessel', id: v.id, name: `${v.name} · ${v.ownerName}` } }
    }
    game.setTarget(best)
  }

  function sendChat() {
    const t = chatInput.trim()
    if (t) net.send({ type: 'chat', text: t })
    chatInput = ''
  }

  // --- input ---------------------------------------------------------------
  const keys = new Set<string>()
  function onKeyDown(e: KeyboardEvent) {
    if ((e.target as HTMLElement)?.tagName === 'INPUT') return
    const k = e.key.toLowerCase()
    keys.add(k)
    // Global (observe + flight): the Assembly, fleet, and menu are reachable anywhere.
    if (k === 'escape') {
      if (showVab) showVab = false
      else if (showFleet) showFleet = false
      else if (screen === 'flight') showMenu = !showMenu
      return
    }
    if (k === 'f' && screen !== 'menu') { showFleet = !showFleet; return }
    if (k === 'b' && screen === 'observe') { openVab(); return }
    if (screen !== 'flight') return
    if (k === ' ') { e.preventDefault(); game.stageNow() }
    if (k === 'g') game.toggleAutopilot()
    if (k === 'm') view = view === 'map' ? 'flight' : 'map'
    if (k === 'p') showBoard = !showBoard
    if (k === 'h' || k === '?') showHelp = !showHelp
    if (k === 'c') circularize()
    if (k === 'r') recover()
    if (k === '.') game.warpUp()
    if (k === ',') game.warpDown()
    // SAS heading hold
    if (k === 'q') game.setHold('prograde')
    if (k === 'e') game.setHold('retrograde')
    if (k === 't' && game.target) game.setHold('target')
    // maneuver node editing
    if (k === 'n') e.shiftKey ? game.addNode() : game.toggleNode()
    if (game.node) {
      const dv = e.shiftKey ? 100 : 10
      const ts = e.shiftKey ? 300 : 30
      if (k === 'i') game.adjustNode(dv, 0)
      if (k === 'k') game.adjustNode(-dv, 0)
      if (k === 'l') game.adjustNode(0, dv)
      if (k === 'j') game.adjustNode(0, -dv)
      if (k === 'o') game.moveNode(ts)
      if (k === 'u') game.moveNode(-ts)
      if (k === 'b') game.armNode()
      if (k === '[') game.cycleNode(-1)
      if (k === ']') game.cycleNode(1)
      if (k === 'backspace' || k === 'delete') { e.preventDefault(); game.removeActiveNode() }
    }
  }
  function onKeyUp(e: KeyboardEvent) {
    keys.delete(e.key.toLowerCase())
  }

  function pollKeys(dt: number) {
    if (game.autopilot) return
    if (keys.has('w')) game.throttle = Math.min(1, game.throttle + dt * 1.2)
    if (keys.has('s')) game.throttle = Math.max(0, game.throttle - dt * 1.2)
    if (keys.has('x')) game.throttle = 0
    if (keys.has('z')) game.throttle = 1
    game.rotateInput = (keys.has('a') ? 1 : 0) + (keys.has('d') ? -1 : 0)
  }

  onMount(() => {
    ctx = canvas.getContext('2d')!
    let last = performanceNow()
    let raf = 0
    function frame() {
      const now = performanceNow()
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      resize()
      if (screen === 'flight') {
        // Advance the sim unless paused (private rooms only).
        if (!paused) {
          pollKeys(dt)
          // Keep the target's live position/velocity fed in, on the SHIP's clock.
          if (game.target) {
            const ts = objectState(game.target.kind, game.target.id, game.st.t)
            if (ts) { game.targetPos = ts.pos; game.targetVel = ts.vel }
            else game.setTarget(null)
          }
          game.update(dt)
        }
        hud = game.readout()
        nodeInfo = game.nodeReadout()
        // Contract detection: claim any open contract this vessel now satisfies.
        if (!paused && game.vesselId) {
          const cctx = { bodyId: game.currentBody(), inOrbit: hud.inOrbit, periapsisAlt: hud.periapsisAlt, landed: hud.landed }
          for (const c of contracts) {
            if (c.claimedBy || claimAttempts.has(c.id)) continue
            const def = contractDef(c.id)
            if (def && contractMet(def, cctx)) { claimAttempts.add(c.id); net.send({ type: 'claim_contract', id: c.id }) }
          }
        }
        // Main view — rendered on the SHIP's clock so bodies sit where their gravity is.
        if (view === 'map') {
          if (mapFollow && game.vesselId) mapCenter = { x: game.st.pos.x, y: game.st.pos.y }
          drawMap(ctx, canvas.width, canvas.height, game, vessels, players, game.st.t, mapZoom, mapCenter, debris)
        } else drawFlight(ctx, canvas.width, canvas.height, game, vessels, players, game.st.t, flightZoom, debris)
        // Picture-in-picture: the OTHER view, small.
        if (showPip && pipCanvas) {
          if (!pipCtx) pipCtx = pipCanvas.getContext('2d')
          if (pipCtx) {
            const pw = pipCanvas.clientWidth, ph = pipCanvas.clientHeight
            if (pipCanvas.width !== pw || pipCanvas.height !== ph) { pipCanvas.width = pw; pipCanvas.height = ph }
            if (view === 'flight') drawMap(pipCtx, pipCanvas.width, pipCanvas.height, game, vessels, players, game.st.t, pipMapZoom, { x: 0, y: 0 }, debris)
            else drawFlight(pipCtx, pipCanvas.width, pipCanvas.height, game, vessels, players, game.st.t, pipFlightZoom, debris)
          }
        }
      } else if (screen === 'observe') {
        // Watching the universe without a craft of your own — the live map of
        // everyone's vessels, the junk, and the bodies, on the universe clock.
        drawMap(ctx, canvas.width, canvas.height, game, vessels, players, universeTime(), mapZoom, mapCenter, debris)
      }
      raf = requestAnimationFrame(frame)
    }
    function resize() {
      const w = canvas.clientWidth, h = canvas.clientHeight
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h }
    }
    // Map pan (drag) and zoom (wheel).
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const f = e.deltaY < 0 ? 1.15 : 1 / 1.15
      if (view === 'map') mapZoom = Math.max(0.15, Math.min(80, mapZoom * f))
      else flightZoom = Math.max(0.15, Math.min(12, flightZoom * f))
    }
    let dragging = false, lastX = 0, lastY = 0
    const onDown = (e: PointerEvent) => {
      if (view !== 'map') return
      dragging = true; lastX = e.clientX; lastY = e.clientY
    }
    const onMove = (e: PointerEvent) => {
      if (!dragging || view !== 'map') return
      const s = mapScale(canvas.width, canvas.height, mapZoom)
      mapCenter = { x: mapCenter.x - (e.clientX - lastX) / s, y: mapCenter.y + (e.clientY - lastY) / s }
      mapFollow = false
      lastX = e.clientX; lastY = e.clientY
    }
    const onUp = () => { dragging = false }
    // Disable the browser context menu everywhere; right-click the map to target.
    const onContext = (e: MouseEvent) => {
      e.preventDefault()
      if (e.target === canvas) pickTarget(e.clientX, e.clientY)
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })
    canvas.addEventListener('pointerdown', onDown)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('contextmenu', onContext)

    raf = requestAnimationFrame(frame)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      canvas.removeEventListener('wheel', onWheel)
      canvas.removeEventListener('pointerdown', onDown)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('contextmenu', onContext)
    }
  })

  const fmt = (n: number, u = '') => `${n >= 1000 ? (n / 1000).toFixed(1) + 'k' : n.toFixed(0)}${u}`
  const km = (m: number) => (Math.abs(m) >= 1000 ? (m / 1000).toFixed(1) + ' km' : m.toFixed(0) + ' m')
</script>

<div class="app">
  <canvas bind:this={canvas} class="scene" class:hidden={screen === 'menu'}></canvas>

  {#if toasts.length}
    <div class="toasts">
      {#each toasts as t (t.id)}
        <div class="toast" class:first={t.first}><b style="color:{t.color}">{t.text}</b></div>
      {/each}
    </div>
  {/if}

  {#if screen === 'flight' && showPip}
    <div class="pip-wrap">
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <canvas bind:this={pipCanvas} class="pip" onclick={swapView} onwheel={onPipWheel} title="click to switch to this view · scroll to zoom"></canvas>
      <div class="pip-label">{view === 'flight' ? '◎ SYSTEM' : '▲ SHIP'}</div>
      <button class="pip-x" onclick={(e) => { e.stopPropagation(); showPip = false }} title="hide minimap">×</button>
    </div>
  {/if}
  {#if screen === 'flight' && !showPip}
    <button class="pip-show" onclick={() => (showPip = true)} title="show minimap">◳ minimap</button>
  {/if}

  {#if showBoard && players.length && screen !== 'menu'}
    <div class="board panel">
      <div class="board-title">{currentRoom === 'frontier' ? 'THE FRONTIER' : currentRoom.toUpperCase()} · {players.length}</div>
      {#each [...players].sort((a, b) => b.science - a.science || b.funds - a.funds) as p (p.id)}
        <div class="board-row" class:me={p.id === you?.id}>
          <span class="dot" style="background:{p.color}"></span>
          <span class="pname">{p.name}</span>
          <span class="pbadges" title="milestones">{p.achieved.length}/{MILESTONE_ORDER.length}</span>
          <span class="psci">⚛{p.science}</span>
        </div>
      {/each}
    </div>
  {/if}

  {#if screen === 'flight'}
    <button class="help-btn" onclick={() => (showHelp = true)} title="Flight manual (H)">?</button>
    <button class="fleet-btn" onclick={() => (showFleet = true)} title="Your fleet (F)">⊙ Fleet</button>
  {/if}

  {#if showHelp}
    <div class="overlay center help-overlay">
      <div class="panel help">
        <h2>Flight Manual</h2>
        <div class="help-cols">
          <div>
            <h3>Fly</h3>
            <p><b>W / S</b> throttle · <b>A / D</b> rotate · <b>Space</b> stage</p>
            <p><b>G</b> autopilot to orbit · <b>, / .</b> time-warp</p>
            <p><b>Q / E</b> SAS hold prograde / retrograde</p>
            <p><b>R</b> recover (return to the assembly for funds)</p>
          </div>
          <div>
            <h3>Navigate</h3>
            <p><b>M</b> map ⇄ flight · scroll zoom · drag pan</p>
            <p><b>Right-click</b> a body or ship on the map to target it</p>
            <p><b>N</b> node · <b>I/K · J/L</b> tune · <b>B</b> arm → auto-burn</p>
            <p><b>⇧N</b> add node · <b>[ / ]</b> cycle · <b>P</b> standings</p>
          </div>
        </div>
        <h3>Missions</h3>
        <div class="obj-list">
          {#each MILESTONE_ORDER as k}
            <span class="obj" class:done={achieved.includes(k)} title={MILESTONES[k].blurb}>{achieved.includes(k) ? '✓' : '○'} {MILESTONES[k].label}</span>
          {/each}
        </div>
        <button onclick={dismissHelp}>Got it — to orbit ▸</button>
      </div>
    </div>
  {/if}

  {#if paused && screen === 'flight' && !showMenu}
    <div class="paused-banner">⏸ PAUSED — Esc for menu</div>
  {/if}

  {#if showMenu}
    <div class="overlay center menu-overlay">
      <div class="panel menu-panel">
        <h2>{currentRoom === 'frontier' ? 'The Frontier' : currentRoom.toUpperCase()}</h2>
        <p class="sub">{callsign} · ⬡{youFunds.toLocaleString()} funds · ⚛{you?.science ?? 0} science</p>
        <button onclick={() => (showMenu = false)}>Resume ▸</button>
        {#if isPrivate}
          <button class="ghost" onclick={() => (paused = !paused)}>{paused ? '▶ Unpause' : '⏸ Pause'}</button>
        {:else}
          <div class="hint">Pause is off in the public Frontier — the shared universe keeps running.</div>
        {/if}
        <button class="ghost" onclick={() => { recover(); showMenu = false }}>↩ Recover &amp; return to Assembly</button>
        <button class="ghost danger" onclick={quitToMenu}>✕ Quit to Menu</button>
        <div class="hint">Your funds, science, and vessels are saved on the server — rejoin anytime.</div>
      </div>
    </div>
  {/if}

  {#if showFleet}
    <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
    <div class="overlay center menu-overlay" onclick={() => (showFleet = false)}>
      <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
      <div class="panel fleet-panel" onclick={(e) => e.stopPropagation()}>
        <h2>YOUR FLEET</h2>
        <p class="sub">{myFleet.length} craft aloft · ⬡{youFunds.toLocaleString()} funds · ⚛{you?.science ?? 0}</p>
        {#if myFleet.length === 0}
          <div class="hint">No craft up yet — roll one out from the Assembly and reach for orbit.</div>
        {:else}
          <div class="fleet-list">
            {#each myFleet as v (v.id)}
              <div class="fleet-row">
                <div class="fleet-meta">
                  <span class="fleet-name">{v.name}{v.id === game.vesselId ? ' ◂ flying now' : ''}</span>
                  <span class="fleet-sub">{fleetInfo(v)}</span>
                </div>
                <div class="fleet-actions">
                  {#if v.vehicle && v.id !== game.vesselId && (v.status === 'orbit' || v.status === 'landed')}
                    <button class="chip fly" onclick={() => flyVessel(v)} title="take control of this craft">▸ Fly</button>
                  {/if}
                  <button class="chip" onclick={() => locate(v)} title="show it on the map">⊙ Locate</button>
                  <button class="chip" onclick={() => recoverVessel(v)} title="bring it home for funds">↩ Recover</button>
                </div>
              </div>
            {/each}
          </div>
        {/if}
        <div class="fleet-foot">
          <button class="ghost" onclick={() => { showFleet = false; openVab() }}>＋ New rocket</button>
          <button onclick={() => (showFleet = false)}>Close ▸</button>
        </div>
      </div>
    </div>
  {/if}

  {#if screen === 'menu'}
    <div class="overlay center">
      <div class="panel title-card">
        <img class="logo" src="/assets/logo.png" alt="First Orbit" width="160" height="160" />
        <h1>FIRST ORBIT</h1>
        <p class="tagline">The universe is expanding. So are we.</p>
        <p class="sub">Build rockets. Reach orbit. Run a shared space program — the dawn of the Mars&#8209;field shipyards.</p>
        <input placeholder="Your callsign" bind:value={callsign} onkeydown={(e) => e.key === 'Enter' && enter()} maxlength="24" />
        <input class="room-input" placeholder="Room code (blank = public Frontier)" bind:value={roomCode} onkeydown={(e) => e.key === 'Enter' && enter()} maxlength="24" />
        <button onclick={enter} disabled={!callsign.trim()}>{callsign && localStorage.getItem('fo-callsign') === callsign.trim() ? 'Rejoin' : 'Begin'}</button>
        <div class="build">{roomCode.trim() ? `private room “${roomCode.trim()}”` : 'public Frontier (everyone)'} · build {BUILD}</div>
      </div>
    </div>
  {/if}

  {#if showVab && screen !== 'menu'}
    <div class="overlay center">
      <div class="panel vab">
        <button class="vab-close" onclick={closeVab} title="close the Assembly (Esc)">✕</button>
        <h2>Vehicle Assembly</h2>
        {#if myFleet.length}
          <button class="chip fleet-vab" onclick={() => { showVab = false; showFleet = true }} title="take control of a craft you already have in space">⊙ Your fleet — fly one of your {myFleet.length} craft already aloft</button>
        {/if}
        <div class="presets">
          <span>Presets</span>
          <button class="chip" onclick={() => applyPreset('Sounding')}>Sounding</button>
          <button class="chip" onclick={() => applyPreset('Orbiter')}>Orbiter</button>
          <button class="chip" onclick={() => applyPreset('Munar')}>Munar</button>
        </div>
        <div class="stages">
          {#each design.stages as s, i}
            <div class="stage">
              <div class="stage-head">
                <b>Stage {i + 1}{i === design.stages.length - 1 ? ' · crew' : ''}</b>
                <span class="stage-perf">{Math.round(perf[i].deltaV)} m/s · TWR {perf[i].twr(g).toFixed(1)}</span>
                {#if design.stages.length > 1}<button class="x" onclick={() => removeStage(i)} title="remove stage">✕</button>{/if}
              </div>
              <div class="stage-icons">
                {#if i === design.stages.length - 1}<img src="/assets/part-cmd-pod.png" alt="pod" title="Command Pod" />{/if}
                {#each Array.from({ length: s.tanks }) as _, t (t)}<img src="/assets/part-tank.png" alt="tank" title="Fuel Tank ({s.tankSize})" class:large={s.tankSize === 'large'} />{/each}
                {#if s.engine !== 'none'}{#each Array.from({ length: s.engineCount ?? 1 }) as _, e (e)}<img src={s.engine === 'main' ? '/assets/part-engine-main.png' : '/assets/part-engine-vac.png'} alt="engine" title="{s.engine} engine" />{/each}{/if}
              </div>
              <div class="stage-row">
                <span class="lbl">Engine</span>
                <button class="opt" class:sel={s.engine === 'main'} onclick={() => setEngine(i, 'main')}>Main</button>
                <button class="opt" class:sel={s.engine === 'vac'} onclick={() => setEngine(i, 'vac')}>Vac</button>
                <button class="opt" class:sel={s.engine === 'none'} onclick={() => setEngine(i, 'none')}>None</button>
                {#if s.engine !== 'none'}
                  <button class="opt" onclick={() => addEngine(i, -1)}>−</button>
                  <span class="count">×{s.engineCount ?? 1}</span>
                  <button class="opt" onclick={() => addEngine(i, 1)}>+</button>
                {/if}
              </div>
              <div class="stage-row">
                <span class="lbl">Tanks</span>
                <button class="opt" onclick={() => addTank(i, -1)}>−</button>
                <span class="count">{s.tanks}</span>
                <button class="opt" onclick={() => addTank(i, 1)}>+</button>
                <button class="opt" class:sel={s.tankSize === 'small'} onclick={() => setTankSize(i, 'small')}>S</button>
                <button class="opt" class:sel={s.tankSize === 'large'} onclick={() => setTankSize(i, 'large')}>L</button>
                <button class="opt fins" class:sel={s.fins} onclick={() => toggleFins(i)}>Fins</button>
              </div>
            </div>
          {/each}
        </div>
        <button class="chip add" onclick={addStage} disabled={design.stages.length >= 5}>+ Add booster stage (bottom)</button>

        <div class="stage crew-row">
          <div class="stage-row">
            <span class="lbl">Crew</span>
            <button class="opt" class:sel={(design.crew ?? 'pod') === 'pod'} onclick={() => setCrew('pod')}>Pod</button>
            <button class="opt" class:sel={design.crew === 'lander'} disabled={youTech < (PARTS['lander'].tier ?? 0)} onclick={() => setCrew('lander')}>Lander{youTech < 1 ? ' 🔒' : ''}</button>
            <button class="opt" class:sel={design.parachute} disabled={youTech < (PARTS['parachute'].tier ?? 0)} onclick={toggleParachute}>Parachute{youTech < 1 ? ' 🔒' : ''}</button>
            <button class="opt" class:sel={design.legs} disabled={youTech < (PARTS['leg'].tier ?? 0)} onclick={toggleLegs}>Legs{youTech < 1 ? ' 🔒' : ''}</button>
          </div>
        </div>

        <div class="totals"><span>Δv <b class:warn={vabDv < 3400}>{vabDv} m/s</b></span><span>Mass <b>{vabMass} t</b></span><span>Cost <b class:warn={!canAfford}>⬡{vabCost.toLocaleString()}</b></span></div>
        <div class="hint">{vabDv < 3400 ? '⚠ ~3400 m/s needed to reach Terra orbit' : '✓ enough Δv for orbit — Luna wants ~5500+'}</div>

        <div class="agency"><b class:warn={!canAfford}>⬡ {youFunds.toLocaleString()}</b> funds &nbsp;·&nbsp; <b>⚛ {you?.science ?? 0}</b> science</div>
        <div class="tech">
          <span class="tech-cur">Tech: <b>{TIER_NAMES[youTech]}</b></span>
          {#if youTech < MAX_TIER}
            <button class="chip" disabled={(you?.science ?? 0) < tierCost(youTech + 1)} onclick={unlockNextTier}>Unlock {TIER_NAMES[youTech + 1]} (⚛{tierCost(youTech + 1)})</button>
          {:else}<span class="tech-cur">— all unlocked</span>{/if}
        </div>

        <div class="contracts-panel">
          <div class="cp-title">CONTRACTS — first to claim wins</div>
          {#each CONTRACTS as c}
            {@const st = contracts.find((s) => s.id === c.id)}
            <div class="cp-row" class:claimed={!!st?.claimedBy}>
              <span class="cp-name">{c.title}{st?.claimedBy ? ` ✓ ${st.claimedName}` : ''}</span>
              <span class="cp-reward">⬡{(c.funds / 1000).toFixed(0)}k · ⚛{c.science}</span>
            </div>
          {/each}
        </div>

        <input placeholder="Vehicle name" bind:value={design.name} maxlength="32" />
        <button onclick={launch} disabled={!buildable || !canAfford}>Roll out & Launch ▸ &nbsp; ⬡{vabCost.toLocaleString()}</button>
        <div class="roster">{players.length} engineer{players.length === 1 ? '' : 's'} on the program{connected ? '' : ' (connecting…)'}</div>
      </div>
    </div>
  {/if}

  {#if screen === 'flight' && hud}
    <div class="hud">
      <div class="readouts panel">
        <div class="body-name">▷ {hud.bodyName.toUpperCase()}{#if nextObjective}<span class="objective" title="next mission">◎ {MILESTONES[nextObjective].label}</span>{/if}</div>
        <div class="row big"><span>ALT</span><b>{km(hud.altitude)}</b></div>
        <div class="row big"><span>SPD</span><b>{fmt(hud.speed, ' m/s')}</b></div>
        <div class="row"><span>Apoapsis</span><b>{hud.apoapsisAlt === Infinity ? '—' : km(hud.apoapsisAlt)}</b></div>
        <div class="row"><span>Periapsis</span><b>{km(hud.periapsisAlt)}</b></div>
        <div class="row"><span>Vert spd</span><b>{hud.verticalSpeed.toFixed(0)} m/s</b></div>
        <div class="row"><span>Stage</span><b>{hud.stage + 1}/{hud.stageCount} · {fmt(hud.fuel)} fuel</b></div>
        <div class="row"><span>TWR</span><b>{hud.twr.toFixed(2)}</b></div>
        <div class="row"><span>Agency</span><b>⬡{(you?.funds ?? 0) >= 1000 ? ((you?.funds ?? 0) / 1000).toFixed(0) + 'k' : (you?.funds ?? 0)} · ⚛{you?.science ?? 0}</b></div>
        {#if hud.targetName}<div class="row tgt"><span>◎ {hud.targetName}</span><b>{km(hud.targetDist ?? 0)}{hud.targetRelSpeed != null ? ` · ${hud.targetRelSpeed.toFixed(0)} m/s` : ''}</b></div>{/if}
        {#if hud.landed}<div class="orbit-flag landed">● LANDED on {hud.bodyName}</div>{:else if hud.inOrbit}<div class="orbit-flag">● STABLE ORBIT</div>{/if}
      </div>

      <div class="throttle panel">
        <div class="bar"><div class="fill" style="height:{hud.throttle * 100}%"></div></div>
        <span>{Math.round(hud.throttle * 100)}%</span>
      </div>

      <div class="controls panel">
        <span class:on={hud.autopilot}>[G] Autopilot {hud.autopilot ? 'ON' : 'off'}</span>
        <span>[Space] Stage</span>
        <span>[A/D] Rotate · [W/S] Throttle</span>
        <span class:on={hud.hold !== 'off'}>[Q/E] SAS{hud.hold !== 'off' ? ' · ' + hud.hold : ''}</span>
        <span>[,/.] Warp {hud.warp}×{hud.burning ? ' · 🔥' : ''}</span>
        <span class:on={!!nodeInfo}>[N] Maneuver node {nodeInfo ? '✓' : ''}</span>
        <span>[M] {view === 'map' ? 'Flight' : 'Map'} · [R] Recover · [P] Standings</span>
      </div>

      {#if hud.targetKind === 'body'}
        <button class="transfer-btn panel" onclick={planTransfer} title="auto-plan a phase-timed transfer">⇆ Plan transfer to {hud.targetName}</button>
      {/if}
      {#if hud.targetKind === 'debris'}
        <button class="transfer-btn salvage-btn panel" class:ready={salvageReady} disabled={!salvageReady} onclick={salvageTarget} title="rendezvous within {SALVAGE_RANGE / 1000} km and match velocity to salvage">
          {salvageReady ? `⊕ Salvage ${hud.targetName}` : `Match velocity to salvage · ${hud.targetDist != null && hud.targetDist < 9999000 ? (hud.targetDist > 1000 ? (hud.targetDist / 1000).toFixed(1) + ' km' : Math.round(hud.targetDist) + ' m') : '—'} · ${Math.round(hud.targetRelSpeed ?? 0)} m/s`}
        </button>
      {/if}
      {#if hud.inOrbit && !nodeInfo}
        <button class="circ-btn panel" onclick={circularize} title="plan and burn a circular orbit at the next apsis (C)">⊙ Circularize orbit</button>
      {/if}

      <div class="sas panel">
        <div class="sas-title">SAS</div>
        <button class="sasb" class:on={hud.hold === 'prograde'} onclick={() => game.setHold('prograde')}>Pro</button>
        <button class="sasb" class:on={hud.hold === 'retrograde'} onclick={() => game.setHold('retrograde')}>Retro</button>
        <button class="sasb" class:on={hud.hold === 'radial-out'} onclick={() => game.setHold('radial-out')}>Rad+</button>
        <button class="sasb" class:on={hud.hold === 'radial-in'} onclick={() => game.setHold('radial-in')}>Rad−</button>
        {#if nodeInfo}<button class="sasb" class:on={hud.hold === 'node'} onclick={() => game.setHold('node')}>Node</button>{/if}
        {#if hud.targetName}
          <button class="sasb tgt" class:on={hud.hold === 'target'} onclick={() => game.setHold('target')} title="point at target">◎</button>
          <button class="sasb tgt" class:on={hud.hold === 'tgt-prograde'} onclick={() => game.setHold('tgt-prograde')} title="toward target (relative velocity)">T▲</button>
          <button class="sasb tgt" class:on={hud.hold === 'tgt-retrograde'} onclick={() => game.setHold('tgt-retrograde')} title="kill relative velocity">T▼</button>
        {/if}
      </div>

      {#if nodeInfo}
        <div class="node panel" class:armed={nodeInfo.armed}>
          <div class="node-title">⬗ MANEUVER {nodeInfo.count > 1 ? `${nodeInfo.index + 1}/${nodeInfo.count}` : ''} {nodeInfo.executing ? '· 🔥 BURNING' : nodeInfo.armed ? '· ARMED ▸' : ''}</div>
          <div class="row"><span>{nodeInfo.executing ? 'Δv left' : 'Δv'}</span><b>{nodeInfo.dv.toFixed(0)} m/s</b></div>
          <div class="row"><span>Prograde</span><b>{nodeInfo.pro >= 0 ? '+' : ''}{nodeInfo.pro.toFixed(0)}</b></div>
          <div class="row"><span>Radial</span><b>{nodeInfo.rad >= 0 ? '+' : ''}{nodeInfo.rad.toFixed(0)}</b></div>
          <div class="row"><span>T−</span><b>{nodeInfo.tMinus > 0 ? fmt(nodeInfo.tMinus, 's') : 'now'}</b></div>
          <div class="row"><span>→ Apo</span><b>{nodeInfo.apoAlt === Infinity ? '— (escape)' : km(nodeInfo.apoAlt)}</b></div>
          <div class="row"><span>→ Peri</span><b>{km(nodeInfo.periAlt)}</b></div>
          <div class="node-keys">[I/K] pro · [J/L] rad · [U/O] time · <b>[B] {nodeInfo.armed ? 'disarm' : 'arm → auto-burn'}</b> · ⇧N add · [/] cycle · Del remove · [N] clear</div>
        </div>
      {/if}

      <div class="chat panel">
        {#each chat as c}<div class="line"><b style="color:{c.color}">{c.from}</b> {c.text}</div>{/each}
        <input placeholder="message…" bind:value={chatInput} onkeydown={(e) => e.key === 'Enter' && sendChat()} />
      </div>

      {#if view === 'map'}
        <div class="map-controls panel">
          <button class="mc" onclick={() => (mapZoom = Math.max(0.15, mapZoom / 1.4))}>−</button>
          <span class="zoom">{mapZoom >= 1 ? mapZoom.toFixed(1) : mapZoom.toFixed(2)}×</span>
          <button class="mc" onclick={() => (mapZoom = Math.min(80, mapZoom * 1.4))}>+</button>
          <button class="mc wide" class:on={mapFollow} onclick={() => (mapFollow = !mapFollow)}>⊙ Follow</button>
          <button class="mc wide" onclick={() => { mapCenter = { x: 0, y: 0 }; mapFollow = false; mapZoom = 1 }}>⌖ Reset</button>
          <span class="mc-hint">scroll = zoom · drag = pan · right-click = target</span>
        </div>
      {/if}
    </div>
  {/if}

  {#if screen === 'observe' && !showVab && !showFleet}
    <div class="observe-bar">
      <button onclick={openVab} title="build a new rocket (B)">🔧 Build rocket</button>
      <button onclick={() => (showFleet = true)} title="your craft in space (F)">⊙ Your fleet · {myFleet.length}</button>
      <span class="ob-hint">Mission Control — scroll/drag to explore the program. Build a rocket, or fly one you already have aloft.</span>
    </div>
    <div class="map-controls panel">
      <button class="mc" onclick={() => (mapZoom = Math.max(0.15, mapZoom / 1.4))}>−</button>
      <span class="zoom">{mapZoom >= 1 ? mapZoom.toFixed(1) : mapZoom.toFixed(2)}×</span>
      <button class="mc" onclick={() => (mapZoom = Math.min(80, mapZoom * 1.4))}>+</button>
      <button class="mc wide" onclick={() => { mapCenter = { x: 0, y: 0 }; mapZoom = 1 }}>⌖ Reset</button>
      <span class="mc-hint">scroll = zoom · drag = pan</span>
    </div>
    <div class="chat panel">
      {#each chat as c}<div class="line"><b style="color:{c.color}">{c.from}</b> {c.text}</div>{/each}
      <input placeholder="message…" bind:value={chatInput} onkeydown={(e) => e.key === 'Enter' && sendChat()} />
    </div>
  {/if}
</div>

<style>
  :global(html, body, #app) { height: 100%; margin: 0; }
  .app { position: fixed; inset: 0; background: #05060a; color: #e8eaed; font-family: system-ui, sans-serif; overflow: hidden; }
  .scene { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
  .scene.hidden { display: none; }
  .overlay { position: absolute; inset: 0; }
  .center { display: flex; align-items: center; justify-content: center; }
  .panel { background: rgba(12, 16, 26, 0.82); border: 1px solid rgba(120, 170, 255, 0.18); border-radius: 10px; padding: 18px; backdrop-filter: blur(4px); }
  .title-card { max-width: 460px; text-align: center; }
  .logo { display: block; margin: 0 auto 8px; filter: drop-shadow(0 4px 16px rgba(0,0,0,0.5)); }
  h1 { font-size: 44px; letter-spacing: 6px; margin: 0 0 4px; font-weight: 800; }
  .tagline { color: #7fb0ff; margin: 0 0 14px; font-style: italic; }
  .sub { color: #9aa0a6; font-size: 14px; line-height: 1.5; }
  input { width: 100%; box-sizing: border-box; margin: 12px 0 8px; padding: 10px 12px; border-radius: 8px; border: 1px solid #2a3142; background: #0c111c; color: #e8eaed; font-size: 15px; }
  button { width: 100%; padding: 11px; border: 0; border-radius: 8px; background: #2f6fed; color: #fff; font-size: 15px; font-weight: 600; cursor: pointer; }
  button:disabled { opacity: 0.4; cursor: default; }
  .build { margin-top: 12px; color: #5a606a; font-size: 12px; }
  .vab { max-width: 540px; max-height: 88vh; overflow-y: auto; position: relative; }
  .presets { display: flex; align-items: center; gap: 8px; margin: 4px 0 12px; color: #7a808a; font-size: 13px; }
  .chip { width: auto; padding: 5px 12px; background: #1a2130; color: #c8ccd2; font-size: 13px; font-weight: 500; }
  .chip.add { width: 100%; margin: 10px 0 4px; background: #16203a; color: #7fb0ff; }
  .stages { display: flex; flex-direction: column; gap: 8px; }
  .stage { background: #0c111c; border: 1px solid #1c2331; border-radius: 8px; padding: 10px 12px; }
  .stage-icons { display: flex; align-items: center; gap: 2px; margin-bottom: 8px; min-height: 30px; flex-wrap: wrap; }
  .stage-icons img { height: 26px; width: auto; object-fit: contain; opacity: 0.92; }
  .stage-icons img.large { height: 34px; }
  .stage-head { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
  .stage-head b { font-size: 14px; }
  .stage-perf { color: #9aa0a6; font-size: 12px; margin-left: auto; }
  .x { width: auto; padding: 2px 8px; background: #2a1c1c; color: #e57373; font-size: 12px; }
  .stage-row { display: flex; align-items: center; gap: 6px; margin: 5px 0; }
  .lbl { width: 56px; color: #7a808a; font-size: 13px; }
  .opt { width: auto; padding: 4px 10px; background: #161c28; color: #aeb4bc; font-size: 12px; font-weight: 500; }
  .opt.sel { background: #2f6fed; color: #fff; }
  .opt.fins.sel { background: #2ecc71; }
  .count { min-width: 18px; text-align: center; font-weight: 700; font-variant-numeric: tabular-nums; }
  .totals { display: flex; gap: 22px; color: #9aa0a6; font-size: 14px; margin: 10px 0 2px; }
  .totals b { color: #e8eaed; }
  .totals b.warn { color: #e57373; }
  .hint { font-size: 12px; color: #7a808a; margin-bottom: 6px; }
  .roster { margin-top: 10px; color: #5a606a; font-size: 13px; text-align: center; }
  .agency { margin: 8px 0 2px; color: #9aa0a6; font-size: 14px; text-align: center; }
  .agency b { color: #f1c40f; }
  .agency b.warn, .totals b.warn { color: #e57373; }
  .crew-row { margin-top: 8px; }
  .tech { display: flex; align-items: center; justify-content: center; gap: 10px; margin: 6px 0 8px; font-size: 13px; color: #9aa0a6; flex-wrap: wrap; }
  .tech-cur b { color: #2ecc71; }
  button:disabled { opacity: 0.4; cursor: default; }
  .contracts-panel { background: #0c111c; border: 1px solid #1c2331; border-radius: 8px; padding: 9px 11px; margin: 6px 0 10px; }
  .cp-title { color: #c39bd3; font-size: 11px; letter-spacing: 1px; margin-bottom: 5px; }
  .cp-row { display: flex; justify-content: space-between; gap: 10px; font-size: 12.5px; color: #c8ccd2; padding: 2px 0; }
  .cp-row.claimed { color: #5a606a; text-decoration: line-through; }
  .cp-row.claimed .cp-reward { color: #5a606a; }
  .cp-reward { color: #f1c40f; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .toasts { position: absolute; top: 16px; left: 50%; transform: translateX(-50%); display: flex; flex-direction: column; gap: 6px; align-items: center; pointer-events: none; z-index: 10; }
  .toast { background: rgba(12, 16, 26, 0.9); border: 1px solid rgba(120, 170, 255, 0.25); border-radius: 999px; padding: 7px 16px; font-size: 13px; box-shadow: 0 4px 16px rgba(0,0,0,0.4); animation: pop 0.25s ease-out; }
  .toast.first { border-color: #f1c40f; box-shadow: 0 0 18px rgba(241,196,15,0.3); }
  @keyframes pop { from { transform: translateY(-8px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
  .hud { position: absolute; inset: 0; pointer-events: none; }
  .hud .panel { position: absolute; pointer-events: auto; }
  .readouts { top: 14px; left: 14px; min-width: 188px; padding: 12px 14px; }
  .row { display: flex; justify-content: space-between; gap: 16px; font-size: 13px; padding: 2px 0; color: #9aa0a6; }
  .row b { color: #e8eaed; font-variant-numeric: tabular-nums; }
  .row.big b { font-size: 18px; }
  .orbit-flag { margin-top: 8px; color: #2ecc71; font-weight: 700; font-size: 13px; letter-spacing: 1px; }
  .orbit-flag.landed { color: #f1c40f; }
  .body-name { font-size: 12px; letter-spacing: 2px; color: #7fb0ff; margin-bottom: 4px; }
  .objective { color: #2ecc71; letter-spacing: 0; margin-left: 8px; font-size: 11px; }
  .help-btn { position: absolute; top: 14px; left: 210px; width: 30px; height: 30px; border-radius: 50%; background: rgba(12,16,26,0.82); border: 1px solid rgba(120,170,255,0.25); color: #7fb0ff; font-weight: 700; font-size: 15px; cursor: pointer; z-index: 6; }
  .help-overlay { z-index: 20; background: rgba(5,6,10,0.55); }
  .help { max-width: 560px; }
  .help h2 { margin: 0 0 12px; font-size: 22px; }
  .help h3 { color: #7fb0ff; font-size: 12px; letter-spacing: 1.5px; margin: 14px 0 6px; }
  .help-cols { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
  .help-cols p { margin: 5px 0; color: #c8ccd2; font-size: 13px; line-height: 1.5; }
  .help-cols b { color: #f1c40f; font-weight: 600; }
  .obj-list { display: flex; flex-wrap: wrap; gap: 6px 14px; margin-bottom: 14px; }
  .obj { color: #7a808a; font-size: 13px; }
  .obj.done { color: #2ecc71; }
  .fleet-btn { position: absolute; top: 14px; left: 252px; z-index: 8; padding: 6px 12px; background: rgba(12,16,26,0.82); border: 1px solid #2a3344; color: #9fb4d8; font-size: 13px; cursor: pointer; border-radius: 6px; }
  .fleet-panel { max-width: 440px; width: 92%; text-align: center; }
  .fleet-panel h2 { margin: 0 0 2px; letter-spacing: 2px; }
  .fleet-list { display: flex; flex-direction: column; gap: 6px; margin: 10px 0; max-height: 46vh; overflow-y: auto; }
  .fleet-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; background: #0c111c; border: 1px solid #1c2331; border-radius: 8px; padding: 8px 11px; text-align: left; }
  .fleet-meta { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
  .fleet-name { color: #e6e9ee; font-weight: 600; font-size: 14px; }
  .fleet-sub { color: #8a909a; font-size: 12px; }
  .fleet-actions { display: flex; gap: 5px; flex-shrink: 0; }
  .chip.fly { background: rgba(46,204,113,0.18); border-color: #2ecc71; color: #2ecc71; }
  .fleet-vab { display: block; width: 100%; margin: 0 0 12px; background: rgba(127,176,255,0.12); border-color: #7fb0ff; color: #aecbff; padding: 9px; }
  .fleet-foot { display: flex; gap: 8px; margin-top: 4px; }
  .fleet-foot button { flex: 1; }
  .vab-close { position: absolute; top: 12px; right: 14px; width: 30px; height: 30px; padding: 0; background: #1a2130; border: 1px solid #2a3344; color: #9aa0a6; font-size: 16px; line-height: 1; cursor: pointer; border-radius: 6px; }
  .observe-bar { position: absolute; top: 14px; left: 50%; transform: translateX(-50%); z-index: 8; display: flex; align-items: center; gap: 10px; background: rgba(12,16,26,0.85); border: 1px solid #1c2331; border-radius: 10px; padding: 8px 12px; max-width: 92vw; }
  .observe-bar button { padding: 7px 13px; background: #1a2130; border: 1px solid #2a3344; color: #dfe3e8; font-size: 13px; font-weight: 600; cursor: pointer; border-radius: 7px; white-space: nowrap; }
  .observe-bar button:first-child { background: rgba(127,176,255,0.16); border-color: #7fb0ff; color: #cfe0ff; }
  .ob-hint { color: #8a909a; font-size: 12px; }
  @media (max-width: 640px) { .ob-hint { display: none; } }
  .menu-overlay { z-index: 22; background: rgba(5,6,10,0.6); }
  .menu-panel { max-width: 360px; text-align: center; }
  .menu-panel h2 { margin: 0 0 2px; letter-spacing: 2px; }
  .menu-panel .ghost { background: #1a2130; color: #c8ccd2; margin-top: 8px; }
  .menu-panel .ghost.danger { background: #2a1c1c; color: #e57373; }
  .paused-banner { position: absolute; top: 14px; left: 50%; transform: translateX(-50%); z-index: 8; background: rgba(241,196,15,0.15); border: 1px solid #f1c40f; color: #f1c40f; padding: 6px 16px; border-radius: 999px; font-size: 13px; font-weight: 600; }
  .pip-wrap { position: absolute; right: 14px; bottom: 236px; width: 220px; height: 150px; z-index: 7; border: 1px solid #2a3344; border-radius: 8px; overflow: hidden; box-shadow: 0 4px 18px rgba(0,0,0,0.5); }
  .pip { display: block; width: 100%; height: 100%; background: #05070d; cursor: pointer; }
  .pip-label { position: absolute; top: 4px; left: 7px; font-size: 10.5px; letter-spacing: 1px; color: #9fb4d8; text-shadow: 0 1px 3px #000; pointer-events: none; }
  .pip-x { position: absolute; top: 2px; right: 2px; width: 20px; height: 20px; padding: 0; background: rgba(0,0,0,0.4); border: none; color: #9aa0a6; font-size: 15px; line-height: 1; cursor: pointer; border-radius: 4px; }
  .pip-show { position: absolute; right: 14px; bottom: 236px; z-index: 7; padding: 5px 11px; background: rgba(12,16,26,0.82); border: 1px solid #2a3344; color: #9fb4d8; font-size: 12px; cursor: pointer; border-radius: 6px; }
  .throttle { top: 14px; right: 14px; display: flex; flex-direction: column; align-items: center; gap: 6px; }
  .throttle .bar { width: 14px; height: 120px; background: #0c111c; border-radius: 7px; overflow: hidden; display: flex; align-items: flex-end; }
  .throttle .fill { width: 100%; background: linear-gradient(#2f6fed, #2ecc71); transition: height 0.05s linear; }
  .controls { bottom: 14px; left: 14px; display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: #9aa0a6; }
  .controls .on { color: #2ecc71; font-weight: 600; }
  .chat { bottom: 14px; right: 14px; width: 260px; max-height: 200px; display: flex; flex-direction: column; gap: 3px; font-size: 12px; }
  .chat .line { color: #c8ccd2; }
  .chat input { margin: 6px 0 0; padding: 6px 8px; font-size: 13px; }
  .map-controls { bottom: 14px; left: 50%; transform: translateX(-50%); display: flex; align-items: center; gap: 6px; padding: 8px 10px; }
  .mc { width: auto; padding: 5px 10px; background: #161c28; color: #c8ccd2; font-size: 13px; font-weight: 600; }
  .mc.wide { font-weight: 500; }
  .mc.on { background: #2ecc71; color: #05060a; }
  .zoom { min-width: 44px; text-align: center; font-size: 13px; color: #9aa0a6; font-variant-numeric: tabular-nums; }
  .mc-hint { color: #6a707a; font-size: 11px; margin-left: 6px; }
  .row.tgt { color: #c39bd3; }
  .row.tgt b { color: #d2b4de; }
  .transfer-btn { position: absolute; bottom: 296px; left: 14px; width: auto; padding: 8px 12px; background: rgba(12,16,26,0.82); border: 1px solid #c39bd3; color: #d2b4de; font-size: 13px; font-weight: 600; cursor: pointer; z-index: 6; }
  .circ-btn { position: absolute; bottom: 344px; left: 14px; width: auto; padding: 8px 12px; background: rgba(12,16,26,0.82); border: 1px solid #2ecc71; color: #2ecc71; font-size: 13px; font-weight: 600; cursor: pointer; z-index: 6; }
  .salvage-btn { border-color: #c39bd3; color: #d9b8e6; max-width: 230px; text-align: left; line-height: 1.25; }
  .salvage-btn.ready { border-color: #2ecc71; color: #2ecc71; background: rgba(46,204,113,0.12); }
  .sas { bottom: 186px; left: 14px; display: flex; flex-wrap: wrap; gap: 4px; align-items: center; max-width: 200px; padding: 8px 10px; }
  .sas-title { width: 100%; color: #7fb0ff; font-size: 11px; letter-spacing: 1.5px; margin-bottom: 2px; }
  .sasb { width: auto; padding: 4px 8px; background: #161c28; color: #aeb4bc; font-size: 12px; font-weight: 600; }
  .sasb.on { background: #f1c40f; color: #05060a; }
  .sasb.tgt.on { background: #c39bd3; }
  .node { bottom: 70px; left: 50%; transform: translateX(-50%); min-width: 220px; }
  .node.armed { border-color: #f1c40f; box-shadow: 0 0 18px rgba(241,196,15,0.25); }
  .node-title { color: #f1c40f; font-weight: 700; font-size: 12px; letter-spacing: 1px; margin-bottom: 6px; }
  .node-keys { margin-top: 6px; color: #6a707a; font-size: 11px; }
  .board { position: absolute; top: 190px; right: 14px; width: 188px; padding: 10px 12px; z-index: 5; }
  .board-title { color: #7fb0ff; font-size: 11px; letter-spacing: 1.5px; margin-bottom: 7px; }
  .board-row { display: flex; align-items: center; gap: 7px; padding: 2px 0; font-size: 12px; color: #c8ccd2; }
  .board-row.me { color: #fff; font-weight: 600; }
  .board-row .dot { width: 8px; height: 8px; border-radius: 50%; flex: 0 0 auto; }
  .pname { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pbadges { color: #7a808a; font-variant-numeric: tabular-nums; }
  .psci { color: #f1c40f; min-width: 34px; text-align: right; font-variant-numeric: tabular-nums; }
</style>
