// Over-the-wire multiplayer oracle — `npm run wstest`.
//
// Boots the real server on a scratch port and drives it with a real WebSocket
// client: handshake, launch, snapshot propagation, orbit settle, chat. Exit 0 =
// the network path works end to end; exit 1 = it broke. This is the MP twin of
// the smoke oracle and the gate for any netcode change.

import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { WebSocket } from 'ws'
import { encode, decode, PROTOCOL_VERSION, type ClientMsg, type ServerMsg } from '../shared/netproto.ts'
import { stateToElements, circularSpeed } from '../shared/orbit.ts'
import { SYSTEM, ROOT } from '../shared/bodies.ts'
import { MILESTONES } from '../shared/milestones.ts'
import { DEBRIS } from '../shared/debris.ts'

const PORT = 8099
process.env.PORT = String(PORT)
process.env.STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fo-wstest-'))

let passed = 0
const failures: string[] = []
const check = (name: string, cond: boolean, detail = '') => {
  if (cond) { passed++; console.log(`  ok  ${name}`) }
  else { failures.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`) }
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

function connect(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
    ws.on('open', () => resolve(ws))
    ws.on('error', reject)
  })
}
function nextOfType<T extends ServerMsg['type']>(ws: WebSocket, type: T, timeout = 2000): Promise<Extract<ServerMsg, { type: T }>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeout)
    const onMsg = (raw: WebSocket.RawData) => {
      const m = decode<ServerMsg>(raw.toString())
      if (m.type === type) {
        clearTimeout(timer)
        ws.off('message', onMsg)
        resolve(m as Extract<ServerMsg, { type: T }>)
      }
    }
    ws.on('message', onMsg)
  })
}
const send = (ws: WebSocket, m: ClientMsg) => ws.send(encode(m))

async function main() {
  await import('./index.ts') // boots the server (listens on PORT)
  await wait(300)

  console.log('First Orbit — wstest\n')

  const a = await connect()
  send(a, { type: 'hello', name: 'Ada', room: 'frontier', protocol: PROTOCOL_VERSION })
  const welcome = await nextOfType(a, 'welcome')
  check('handshake -> welcome', !!welcome.you.id && welcome.players.length >= 1, `player=${welcome.you.name}`)
  check('welcome carries funds', welcome.you.funds > 0, `funds=${welcome.you.funds}`)

  send(a, { type: 'launch', vesselName: 'Pathfinder I', bodyId: ROOT, cost: 0, vehicle: { stages: [{ partIds: ['engine-main', 'tank-large', 'cmd-pod'] }] } })
  const created = await nextOfType(a, 'vesselCreated')
  check('launch -> vesselCreated', created.vessel.ownerName === 'Ada', `name=${created.vessel.name}`)
  check('vessel carries its vehicle (for resume)', !!created.vessel.vehicle && created.vessel.vehicle.stages.length === 1, `vehicle=${!!created.vessel.vehicle}`)
  const vid = created.vessel.id

  const snap = await nextOfType(a, 'snapshot')
  check('snapshot includes the vessel', snap.vessels.some((v) => v.id === vid), `vessels=${snap.vessels.length}`)

  // Settle onto a circular Terra orbit and confirm the status propagates.
  const r = SYSTEM[ROOT].radius + 300_000 // a comsat-low-qualifying orbit
  const orbit = stateToElements({ x: r, y: 0 }, { y: circularSpeed(SYSTEM[ROOT].mu, r), x: 0 }, SYSTEM[ROOT].mu, welcome.universeTime)
  send(a, { type: 'settle', vesselId: vid, orbit, status: 'orbit', bodyId: ROOT, fuel: 1234, stageIndex: 0 })
  await wait(250)
  const snap2 = await nextOfType(a, 'snapshot')
  const mine = snap2.vessels.find((v) => v.id === vid)
  check('vessel settles into orbit', mine?.status === 'orbit' && !!mine?.orbit, `status=${mine?.status}`)
  check('settle persists fuel + stage (for resume)', mine?.fuel === 1234 && mine?.stageIndex === 0, `fuel=${mine?.fuel} stage=${mine?.stageIndex}`)

  // A second player sees the first player's vessel (shared program).
  const b = await connect()
  send(b, { type: 'hello', name: 'Boyd', room: 'frontier', protocol: PROTOCOL_VERSION })
  const welcomeB = await nextOfType(b, 'welcome')
  const sharedV = welcomeB.vessels.find((v) => v.id === vid)
  check('second player sees shared vessel', !!sharedV, `vessels=${welcomeB.vessels.length}`)
  check('reconnect carries resume data (vehicle + fuel)', !!sharedV?.vehicle && sharedV?.fuel === 1234, `vehicle=${!!sharedV?.vehicle} fuel=${sharedV?.fuel}`)

  // Chat broadcast reaches the other client.
  send(a, { type: 'chat', text: 'liftoff in 3...' })
  const chat = await nextOfType(b, 'chat')
  check('chat broadcast', chat.from === 'Ada' && chat.text.includes('liftoff'), `text=${chat.text}`)

  // Milestone: first award broadcasts an achievement with the funds reward.
  send(a, { type: 'milestone', vesselId: vid, kind: 'orbit' })
  const ach = await nextOfType(b, 'achievement')
  check('milestone -> achievement broadcast', ach.kind === 'orbit' && ach.first && ach.funds === MILESTONES.orbit.funds, `funds=${ach.funds} first=${ach.first}`)

  // Idempotent: a second award is a no-op. Verify via a fresh client's welcome
  // (avoids the achievement/players back-to-back delivery race).
  send(a, { type: 'milestone', vesselId: vid, kind: 'orbit' })
  await wait(150)
  const c = await connect()
  send(c, { type: 'hello', name: 'Cyril', room: 'frontier', protocol: PROTOCOL_VERSION })
  const wc = await nextOfType(c, 'welcome')
  const ada = wc.players.find((p) => p.name === 'Ada')!
  check(
    'milestone awarded once (idempotent) + funds credited',
    ada.funds === welcome.you.funds + MILESTONES.orbit.funds && ada.achieved.filter((k) => k === 'orbit').length === 1,
    `funds=${ada.funds} achieved=${ada.achieved.join(',')}`,
  )

  // Room isolation: a player in a different room is in a separate universe.
  const d = await connect()
  send(d, { type: 'hello', name: 'Dax', room: 'private1', protocol: PROTOCOL_VERSION })
  const wd = await nextOfType(d, 'welcome')
  check(
    'rooms are isolated',
    wd.room === 'private1' && !wd.vessels.some((v) => v.id === vid) && wd.players.every((p) => p.name !== 'Ada'),
    `room=${wd.room} vessels=${wd.vessels.length} players=${wd.players.map((p) => p.name).join(',')}`,
  )

  // Economy: a launch you can't afford is rejected.
  send(a, { type: 'launch', vesselName: 'Tooexpensive', bodyId: ROOT, cost: 99_999_999 })
  const err = await nextOfType(a, 'error', 1500).catch(() => null)
  check('unaffordable launch rejected', !!err && err.message.includes('funds'), err ? err.message : 'no error received')

  // Contracts: Ada's 300 km orbit qualifies for comsat-low; she claims it.
  send(a, { type: 'claim_contract', id: 'comsat-low' })
  const claimed = await nextOfType(b, 'contract_claimed', 2000).catch(() => null)
  check('contract claimed (qualifying vessel)', claimed?.id === 'comsat-low' && claimed.playerName === 'Ada' && claimed.funds > 0, `${claimed?.playerName} / ${claimed?.funds}`)
  // Boyd has no qualifying vessel; his claim is rejected (the contract stays Ada's).
  send(b, { type: 'claim_contract', id: 'comsat-low' })
  await wait(200)
  const e = await connect()
  send(e, { type: 'hello', name: 'Evan', room: 'frontier', protocol: PROTOCOL_VERSION })
  const we = await nextOfType(e, 'welcome')
  const cs = we.contracts.find((x) => x.id === 'comsat-low')
  check('contract is first-come (stays the claimant’s)', cs?.claimedName === 'Ada', `claimedBy=${cs?.claimedName}`)
  e.close()

  // Salvage: park Ada's vessel exactly on a derelict's orbit (perfect rendezvous),
  // then recover it. Boyd, with no vessel near it, can't.
  const junk = DEBRIS[0]
  send(a, { type: 'settle', vesselId: vid, orbit: junk.orbit, status: 'orbit', bodyId: ROOT })
  await wait(250)
  send(a, { type: 'salvage', id: junk.id })
  const salv = await nextOfType(b, 'salvaged', 2000).catch(() => null)
  check('salvage rewarded on rendezvous', salv?.id === junk.id && salv.funds === junk.funds, `${salv?.name} / ${salv?.funds}`)
  send(b, { type: 'salvage', id: DEBRIS[1].id }) // Boyd has no qualifying vessel
  send(a, { type: 'salvage', id: junk.id }) // already gone — no-op
  await wait(200)
  const f = await connect()
  send(f, { type: 'hello', name: 'Fitz', room: 'frontier', protocol: PROTOCOL_VERSION })
  const wf = await nextOfType(f, 'welcome')
  check('salvaged piece gone, the rest still drifting', !wf.debris.some((d) => d.id === junk.id) && wf.debris.length === DEBRIS.length - 1, `debris=${wf.debris.length}/${DEBRIS.length}`)
  f.close()

  a.close(); b.close(); c.close(); d.close()
  console.log(`\n${passed} passed, ${failures.length} failed`)
  if (failures.length) { for (const f of failures) console.log(`  - ${f}`); process.exit(1) }
  console.log('wstest green ✓')
  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })
