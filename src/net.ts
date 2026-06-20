// Thin WebSocket client for the shared space program.
//
// Same-origin /ws in all environments (Vite proxies it to the Node server in dev;
// in prod the Node server serves both the page and the socket). Reconnects with
// backoff so a redeploy doesn't strand a player mid-session.

import {
  encode,
  decode,
  PROTOCOL_VERSION,
  type ClientMsg,
  type ServerMsg,
  type PlayerInfo,
  type VesselState,
} from '../shared/netproto.ts'

type Handler = (msg: ServerMsg) => void

export class Net {
  private ws?: WebSocket
  private name = ''
  private room = 'frontier'
  private handlers = new Set<Handler>()
  private backoff = 500
  connected = false

  on(h: Handler): () => void {
    this.handlers.add(h)
    return () => this.handlers.delete(h)
  }

  connect(name: string, room: string): void {
    this.name = name
    this.room = room
    this.open()
  }

  private open(): void {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${location.host}/ws`)
    this.ws = ws
    ws.onopen = () => {
      this.connected = true
      this.backoff = 500
      this.send({ type: 'hello', name: this.name, room: this.room, protocol: PROTOCOL_VERSION })
    }
    ws.onmessage = (e) => {
      let msg: ServerMsg
      try {
        msg = decode<ServerMsg>(e.data)
      } catch {
        return
      }
      for (const h of this.handlers) h(msg)
    }
    ws.onclose = () => {
      this.connected = false
      setTimeout(() => this.open(), this.backoff)
      this.backoff = Math.min(this.backoff * 2, 8000)
    }
    ws.onerror = () => ws.close()
  }

  send(msg: ClientMsg): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(encode(msg))
  }

  /** Close the connection and stop reconnecting (quit to menu). */
  disconnect(): void {
    const ws = this.ws
    this.ws = undefined
    this.connected = false
    if (ws) {
      ws.onclose = null
      ws.onerror = null
      ws.close()
    }
  }
}

export type { PlayerInfo, VesselState, ServerMsg }
