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

const program = new Program(STATE_DIR)

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
}
const clients = new Set<Client>()

function send(ws: WebSocket, msg: ServerMsg): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(encode(msg))
}
function broadcast(msg: ServerMsg): void {
  const s = encode(msg)
  for (const c of clients) if (c.ws.readyState === WebSocket.OPEN) c.ws.send(s)
}

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
        const you = program.join(msg.name)
        client.playerId = you.id
        send(ws, {
          type: 'welcome',
          you,
          universeTime: program.universeTime(),
          players: program.roster(),
          vessels: program.allVessels(),
          build: BUILD_SHA,
        })
        broadcast({ type: 'players', players: program.roster() })
        break
      }
      case 'launch': {
        const me = client.playerId && program.player(client.playerId)
        if (!me) return
        const v = program.createVessel(me, msg.vesselName, msg.bodyId || ROOT)
        broadcast({ type: 'vesselCreated', vessel: v })
        break
      }
      case 'flight': {
        if (!client.playerId) return
        program.updateFlight(msg.vesselId, client.playerId, {
          x: msg.x, y: msg.y, vx: msg.vx, vy: msg.vy, heading: msg.heading, t: msg.t,
        })
        break
      }
      case 'settle': {
        if (!client.playerId) return
        program.settle(msg.vesselId, client.playerId, msg.orbit, msg.status, msg.bodyId)
        break
      }
      case 'recover': {
        if (!client.playerId) return
        program.recover(msg.vesselId, client.playerId)
        break
      }
      case 'chat': {
        const me = client.playerId && program.player(client.playerId)
        if (!me) return
        const text = msg.text.trim().slice(0, 280)
        if (text) broadcast({ type: 'chat', from: me.name, color: me.color, text, ts: Date.now() })
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

// Universe snapshot broadcast — the shared map heartbeat.
setInterval(() => {
  if (clients.size === 0) return
  broadcast({ type: 'snapshot', universeTime: program.universeTime(), vessels: program.allVessels() })
}, 1000 / SNAPSHOT_HZ)

server.listen(PORT, () => {
  console.log(`First Orbit server on :${PORT} (build ${BUILD_SHA}, system "${SYSTEM[ROOT].name}")`)
})
