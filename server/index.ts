// First Orbit — multiplayer server.
//
// One Node process: serves the built Vite client (dist/) over HTTP and hosts the
// shared space program on a same-origin WebSocket at /ws. Mirrors the deadweight
// deployment shape: /healthz for the container probe, /version for the deploy
// oracle (the git short-sha baked in at build time).

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer, WebSocket } from 'ws'
import { Program } from './program.ts'
import { SYSTEM, ROOT } from '../shared/bodies.ts'
import { encode, decode, SNAPSHOT_HZ, PROTOCOL_VERSION, type ClientMsg, type ServerMsg } from '../shared/netproto.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DIST = path.resolve(__dirname, '..', 'dist')
const PORT = Number(process.env.PORT) || 8080
const STATE_DIR = process.env.STATE_DIR || path.resolve(__dirname, '..', 'data')

let BUILD_SHA = 'dev'
try {
  BUILD_SHA = fs.readFileSync(path.join(DIST, 'version.txt'), 'utf8').trim() || 'dev'
} catch {
  /* no build stamp before a production build — stays 'dev' */
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
}

// One independent universe per room. The public "frontier" room is the MMO that
// everyone joins by default; private rooms are created on first join by code.
const rooms = new Map<string, Program>()
const sanitizeRoom = (r: string): string =>
  (r || 'frontier').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 24) || 'frontier'
function room(id: string): Program {
  let p = rooms.get(id)
  if (!p) {
    p = new Program(path.join(STATE_DIR, `room-${id}.json`))
    rooms.set(id, p)
  }
  return p
}

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse): void {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0])
  if (urlPath === '/healthz') return void res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok')
  if (urlPath === '/version') return void res.writeHead(200, { 'Content-Type': 'text/plain' }).end(BUILD_SHA)

  let rel = urlPath === '/' ? '/index.html' : urlPath
  let file = path.join(DIST, rel)
  // SPA fallback: unknown non-asset paths serve index.html.
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    if (path.extname(rel)) return void res.writeHead(404).end('not found')
    file = path.join(DIST, 'index.html')
    rel = '/index.html'
  }
  // Guard against path traversal.
  if (!file.startsWith(DIST)) return void res.writeHead(403).end('forbidden')
  try {
    const body = fs.readFileSync(file)
    res.writeHead(200, { 'Content-Type': CONTENT_TYPES[path.extname(file)] || 'application/octet-stream' })
    res.end(body)
  } catch {
    res.writeHead(500).end('error')
  }
}

const server = http.createServer(serveStatic)
const wss = new WebSocketServer({ server, path: '/ws' })

interface Client {
  ws: WebSocket
  playerId?: string
  room?: string
}
const clients = new Set<Client>()

function send(ws: WebSocket, msg: ServerMsg): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(encode(msg))
}
// Broadcasts are scoped to a room — players only see their own universe.
function broadcastRoom(roomId: string, msg: ServerMsg): void {
  const s = encode(msg)
  for (const c of clients) if (c.room === roomId && c.ws.readyState === WebSocket.OPEN) c.ws.send(s)
}
const progOf = (c: Client): Program | undefined => (c.room ? rooms.get(c.room) : undefined)

wss.on('connection', (ws) => {
  const client: Client = { ws }
  clients.add(client)

  ws.on('message', (raw) => {
    let msg: ClientMsg
    try {
      msg = decode<ClientMsg>(raw.toString())
    } catch {
      return
    }
    switch (msg.type) {
      case 'hello': {
        if (msg.protocol !== PROTOCOL_VERSION) {
          send(ws, { type: 'error', message: `protocol mismatch (server ${PROTOCOL_VERSION})` })
          return
        }
        const roomId = sanitizeRoom(msg.room)
        client.room = roomId
        const prog = room(roomId)
        const you = prog.join(msg.name)
        client.playerId = you.id
        send(ws, {
          type: 'welcome',
          you,
          room: roomId,
          universeTime: prog.universeTime(),
          players: prog.roster(),
          vessels: prog.allVessels(),
          build: BUILD_SHA,
        })
        broadcastRoom(roomId, { type: 'players', players: prog.roster() })
        break
      }
      case 'launch': {
        const prog = progOf(client)
        const me = prog && client.playerId && prog.player(client.playerId)
        if (!prog || !me) return
        const v = prog.createVessel(me, msg.vesselName, msg.bodyId || ROOT)
        broadcastRoom(client.room!, { type: 'vesselCreated', vessel: v })
        break
      }
      case 'flight': {
        const prog = progOf(client)
        if (!prog || !client.playerId) return
        prog.updateFlight(msg.vesselId, client.playerId, {
          x: msg.x, y: msg.y, vx: msg.vx, vy: msg.vy, heading: msg.heading, t: msg.t,
        })
        break
      }
      case 'settle': {
        const prog = progOf(client)
        if (!prog || !client.playerId) return
        prog.settle(msg.vesselId, client.playerId, msg.orbit, msg.status, msg.bodyId)
        break
      }
      case 'recover': {
        const prog = progOf(client)
        if (!prog || !client.playerId) return
        prog.recover(msg.vesselId, client.playerId)
        broadcastRoom(client.room!, { type: 'players', players: prog.roster() })
        break
      }
      case 'milestone': {
        const prog = progOf(client)
        const me = prog && client.playerId && prog.player(client.playerId)
        if (!prog || !me) return
        const res = prog.awardMilestone(me.id, msg.kind)
        if (res?.newly) {
          broadcastRoom(client.room!, { type: 'achievement', playerName: me.name, color: me.color, kind: msg.kind, funds: res.funds, science: res.science, first: res.first, ts: Date.now() })
          broadcastRoom(client.room!, { type: 'players', players: prog.roster() })
        }
        break
      }
      case 'chat': {
        const prog = progOf(client)
        const me = prog && client.playerId && prog.player(client.playerId)
        if (!prog || !me) return
        const text = msg.text.trim().slice(0, 280)
        if (text) broadcastRoom(client.room!, { type: 'chat', from: me.name, color: me.color, text, ts: Date.now() })
        break
      }
      case 'ping':
        send(ws, { type: 'pong' })
        break
    }
  })

  ws.on('close', () => clients.delete(client))
  ws.on('error', () => clients.delete(client))
})

// Per-room universe snapshot broadcast — the shared map heartbeat, scoped to each room.
setInterval(() => {
  if (clients.size === 0) return
  const active = new Set<string>()
  for (const c of clients) if (c.room) active.add(c.room)
  for (const id of active) {
    const prog = rooms.get(id)
    if (prog) broadcastRoom(id, { type: 'snapshot', universeTime: prog.universeTime(), vessels: prog.allVessels() })
  }
}, 1000 / SNAPSHOT_HZ)

server.listen(PORT, () => {
  console.log(`First Orbit server on :${PORT} (build ${BUILD_SHA}, system "${SYSTEM[ROOT].name}")`)
})
