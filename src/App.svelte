<script lang="ts">
  import { onMount } from 'svelte'
  import { Net } from './net.ts'
  import { Game } from './game.ts'
  import { drawFlight, drawMap } from './render.ts'
  import { referenceRocket, performance as stagePerformance, totalDeltaV, totalMass } from '../shared/vehicle.ts'
  import { SYSTEM, ROOT, surfaceGravity } from '../shared/bodies.ts'
  import type { PlayerInfo, VesselState, ServerMsg } from '../shared/netproto.ts'
  import { MILESTONES } from '../shared/milestones.ts'

  const BUILD = __BUILD_SHA__
  const terra = SYSTEM[ROOT]

  let screen = $state<'menu' | 'vab' | 'flight'>('menu')
  let view = $state<'flight' | 'map'>('flight')
  let callsign = $state('')
  let connected = $state(false)
  let players = $state<PlayerInfo[]>([])
  let vessels = $state<VesselState[]>([])
  let chat = $state<{ from: string; color: string; text: string }[]>([])
  let chatInput = $state('')
  let mapZoom = $state(1)
  let hud = $state<ReturnType<Game['readout']> | null>(null)
  let nodeInfo = $state<ReturnType<Game['nodeReadout']>>(null)
  let you = $state<PlayerInfo | null>(null)
  let toasts = $state<{ id: number; text: string; color: string; first: boolean }[]>([])
  let toastSeq = 0
  let showBoard = $state(true)

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

  // --- Vehicle Assembly: an editable, persisted rocket design ---------------
  type StageDesign = { engine: 'none' | 'main' | 'vac'; engineCount: number; tanks: number; tankSize: 'small' | 'large'; fins: boolean }
  type Design = { name: string; stages: StageDesign[] }
  const PRESETS: Record<string, Design> = {
    Sounding: { name: 'Sounding I', stages: [{ engine: 'main', engineCount: 1, tanks: 1, tankSize: 'small', fins: true }] },
    Orbiter: { name: 'Pathfinder I', stages: [{ engine: 'main', engineCount: 1, tanks: 1, tankSize: 'large', fins: true }, { engine: 'vac', engineCount: 1, tanks: 1, tankSize: 'small', fins: false }] },
    Munar: { name: 'Selene I', stages: [{ engine: 'main', engineCount: 3, tanks: 2, tankSize: 'large', fins: true }, { engine: 'main', engineCount: 1, tanks: 1, tankSize: 'large', fins: false }, { engine: 'vac', engineCount: 1, tanks: 2, tankSize: 'small', fins: false }] },
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
      if (i === d.stages.length - 1) ids.push('cmd-pod') // crew pod rides the top stage
      return { partIds: ids }
    })
    return { name: d.name || 'Unnamed', stages }
  }
  let vehicle = $derived(buildVehicle(design))
  let perf = $derived(stagePerformance(vehicle))
  let vabDv = $derived(Math.round(totalDeltaV(vehicle)))
  let vabMass = $derived((totalMass(vehicle) / 1000).toFixed(1))
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
        serverTime = msg.universeTime
        serverStamp = performanceNow()
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
        if (msg.vessel.ownerName === callsign && screen === 'vab') {
          game.launch(pendingVehicle, msg.vessel.id)
          screen = 'flight'
          view = 'flight'
        }
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
    net.connect(name)
    screen = 'vab'
  }

  function launch() {
    pendingVehicle = buildVehicle(design)
    net.send({ type: 'launch', vesselName: design.name.trim() || 'Unnamed', bodyId: ROOT })
  }

  function recover() {
    if (game.vesselId) net.send({ type: 'recover', vesselId: game.vesselId })
    game.vesselId = ''
    screen = 'vab'
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
    if (screen !== 'flight') return
    if (k === ' ') { e.preventDefault(); game.stageNow() }
    if (k === 'g') game.toggleAutopilot()
    if (k === 'm') view = view === 'map' ? 'flight' : 'map'
    if (k === 'p') showBoard = !showBoard
    if (k === 'r') recover()
    if (k === '.') game.warp = Math.min(100000, game.warp * 10)
    if (k === ',') game.warp = Math.max(1, game.warp / 10)
    // maneuver node editing
    if (k === 'n') game.toggleNode()
    if (game.node) {
      const dv = e.shiftKey ? 100 : 10
      const ts = e.shiftKey ? 300 : 30
      if (k === 'i') game.adjustNode(dv, 0)
      if (k === 'k') game.adjustNode(-dv, 0)
      if (k === 'l') game.adjustNode(0, dv)
      if (k === 'j') game.adjustNode(0, -dv)
      if (k === 'o') game.moveNode(ts)
      if (k === 'u') game.moveNode(-ts)
      if (k === 'b') game.executeNode()
      if (k === 'y') game.toggleWarpToNode()
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
        pollKeys(dt)
        game.update(dt)
        hud = game.readout()
        nodeInfo = game.nodeReadout()
        if (view === 'map') drawMap(ctx, canvas.width, canvas.height, game, vessels, players, universeTime(), mapZoom)
        else drawFlight(ctx, canvas.width, canvas.height, game, vessels, players, universeTime())
      }
      raf = requestAnimationFrame(frame)
    }
    function resize() {
      const w = canvas.clientWidth, h = canvas.clientHeight
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h }
    }
    raf = requestAnimationFrame(frame)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => { cancelAnimationFrame(raf); window.removeEventListener('keydown', onKeyDown); window.removeEventListener('keyup', onKeyUp) }
  })

  const fmt = (n: number, u = '') => `${n >= 1000 ? (n / 1000).toFixed(1) + 'k' : n.toFixed(0)}${u}`
  const km = (m: number) => (Math.abs(m) >= 1000 ? (m / 1000).toFixed(1) + ' km' : m.toFixed(0) + ' m')
</script>

<div class="app">
  <canvas bind:this={canvas} class="scene" class:hidden={screen !== 'flight'}></canvas>

  {#if toasts.length}
    <div class="toasts">
      {#each toasts as t (t.id)}
        <div class="toast" class:first={t.first}><b style="color:{t.color}">{t.text}</b></div>
      {/each}
    </div>
  {/if}

  {#if showBoard && players.length && screen !== 'menu'}
    <div class="board panel">
      <div class="board-title">SPACE PROGRAM · {players.length}</div>
      {#each [...players].sort((a, b) => b.science - a.science || b.funds - a.funds) as p (p.id)}
        <div class="board-row" class:me={p.id === you?.id}>
          <span class="dot" style="background:{p.color}"></span>
          <span class="pname">{p.name}</span>
          <span class="pbadges" title="milestones">{p.achieved.length}/6</span>
          <span class="psci">⚛{p.science}</span>
        </div>
      {/each}
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
        <button onclick={enter} disabled={!callsign.trim()}>Begin</button>
        <div class="build">build {BUILD}</div>
      </div>
    </div>
  {/if}

  {#if screen === 'vab'}
    <div class="overlay center">
      <div class="panel vab">
        <h2>Vehicle Assembly</h2>
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
        <div class="totals"><span>Δv <b class:warn={vabDv < 3400}>{vabDv} m/s</b></span><span>Mass <b>{vabMass} t</b></span><span>Stages <b>{design.stages.length}</b></span></div>
        <div class="hint">{vabDv < 3400 ? '⚠ ~3400 m/s needed to reach Terra orbit' : '✓ enough Δv for orbit — Luna wants ~5500+'}</div>
        <div class="agency">Agency &nbsp; <b>⬡ {(you?.funds ?? 0).toLocaleString()}</b> funds &nbsp;·&nbsp; <b>⚛ {you?.science ?? 0}</b> science</div>
        <input placeholder="Vehicle name" bind:value={design.name} maxlength="32" />
        <button onclick={launch}>Roll out & Launch ▸</button>
        <div class="roster">{players.length} engineer{players.length === 1 ? '' : 's'} on the program{connected ? '' : ' (connecting…)'}</div>
      </div>
    </div>
  {/if}

  {#if screen === 'flight' && hud}
    <div class="hud">
      <div class="readouts panel">
        <div class="body-name">▷ {hud.bodyName.toUpperCase()}</div>
        <div class="row big"><span>ALT</span><b>{km(hud.altitude)}</b></div>
        <div class="row big"><span>SPD</span><b>{fmt(hud.speed, ' m/s')}</b></div>
        <div class="row"><span>Apoapsis</span><b>{hud.apoapsisAlt === Infinity ? '—' : km(hud.apoapsisAlt)}</b></div>
        <div class="row"><span>Periapsis</span><b>{km(hud.periapsisAlt)}</b></div>
        <div class="row"><span>Vert spd</span><b>{hud.verticalSpeed.toFixed(0)} m/s</b></div>
        <div class="row"><span>Stage</span><b>{hud.stage + 1}/{hud.stageCount} · {fmt(hud.fuel)} fuel</b></div>
        <div class="row"><span>TWR</span><b>{hud.twr.toFixed(2)}</b></div>
        <div class="row"><span>Agency</span><b>⬡{(you?.funds ?? 0) >= 1000 ? ((you?.funds ?? 0) / 1000).toFixed(0) + 'k' : (you?.funds ?? 0)} · ⚛{you?.science ?? 0}</b></div>
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
        <span>[,/.] Warp {hud.warp}×</span>
        <span class:on={!!nodeInfo}>[N] Maneuver node {nodeInfo ? '✓' : ''}</span>
        <span>[M] {view === 'map' ? 'Flight' : 'Map'} · [R] Recover · [P] Standings</span>
      </div>

      {#if nodeInfo}
        <div class="node panel">
          <div class="node-title">⬗ MANEUVER {nodeInfo.executing ? '· BURNING' : ''}</div>
          <div class="row"><span>Δv</span><b>{nodeInfo.dv.toFixed(0)} m/s</b></div>
          <div class="row"><span>Prograde</span><b>{nodeInfo.pro >= 0 ? '+' : ''}{nodeInfo.pro.toFixed(0)}</b></div>
          <div class="row"><span>Radial</span><b>{nodeInfo.rad >= 0 ? '+' : ''}{nodeInfo.rad.toFixed(0)}</b></div>
          <div class="row"><span>T−</span><b>{nodeInfo.tMinus > 0 ? fmt(nodeInfo.tMinus, 's') : 'now'}</b></div>
          <div class="row"><span>→ Apo</span><b>{nodeInfo.apoAlt === Infinity ? '— (escape)' : km(nodeInfo.apoAlt)}</b></div>
          <div class="row"><span>→ Peri</span><b>{km(nodeInfo.periAlt)}</b></div>
          <div class="node-keys">[I/K] pro · [J/L] rad · [U/O] time · [Y] warp-to · [B] burn · [N] clear · ⇧=×10</div>
        </div>
      {/if}

      <div class="chat panel">
        {#each chat as c}<div class="line"><b style="color:{c.color}">{c.from}</b> {c.text}</div>{/each}
        <input placeholder="message…" bind:value={chatInput} onkeydown={(e) => e.key === 'Enter' && sendChat()} />
      </div>
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
  .vab { max-width: 540px; max-height: 88vh; overflow-y: auto; }
  .presets { display: flex; align-items: center; gap: 8px; margin: 4px 0 12px; color: #7a808a; font-size: 13px; }
  .chip { width: auto; padding: 5px 12px; background: #1a2130; color: #c8ccd2; font-size: 13px; font-weight: 500; }
  .chip.add { width: 100%; margin: 10px 0 4px; background: #16203a; color: #7fb0ff; }
  .stages { display: flex; flex-direction: column; gap: 8px; }
  .stage { background: #0c111c; border: 1px solid #1c2331; border-radius: 8px; padding: 10px 12px; }
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
  .throttle { top: 14px; right: 14px; display: flex; flex-direction: column; align-items: center; gap: 6px; }
  .throttle .bar { width: 14px; height: 120px; background: #0c111c; border-radius: 7px; overflow: hidden; display: flex; align-items: flex-end; }
  .throttle .fill { width: 100%; background: linear-gradient(#2f6fed, #2ecc71); transition: height 0.05s linear; }
  .controls { bottom: 14px; left: 14px; display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: #9aa0a6; }
  .controls .on { color: #2ecc71; font-weight: 600; }
  .chat { bottom: 14px; right: 14px; width: 260px; max-height: 200px; display: flex; flex-direction: column; gap: 3px; font-size: 12px; }
  .chat .line { color: #c8ccd2; }
  .chat input { margin: 6px 0 0; padding: 6px 8px; font-size: 13px; }
  .node { bottom: 14px; left: 50%; transform: translateX(-50%); min-width: 220px; }
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
