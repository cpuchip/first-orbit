#!/usr/bin/env node
// First Orbit — MCP server.
//
// Gives an AI buddy eyes on the game and a voice in the room: read every vessel's
// orbit and position, read the roster, and post coordination into chat. It's a
// thin bridge over the game server's read/chat API (server/index.ts), so it works
// against the live game (https://orbit.cpuchip.net) or a local dev server.
//
//   FIRST_ORBIT_URL=https://orbit.cpuchip.net  (default)
//
// Wire it into Claude Code:  claude mcp add first-orbit -- node /path/to/mcp/server.mjs
// or add it to .mcp.json (see README.md).

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const BASE = (process.env.FIRST_ORBIT_URL ?? 'https://orbit.cpuchip.net').replace(/\/$/, '')
const out = (o) => ({ content: [{ type: 'text', text: typeof o === 'string' ? o : JSON.stringify(o, null, 2) }] })

const server = new McpServer({ name: 'first-orbit', version: '0.1.0' })

server.tool(
  'list_rooms',
  'List the active First Orbit rooms (each is a separate universe) with player and vessel counts. "frontier" is the public MMO everyone shares.',
  {},
  async () => {
    const r = await fetch(`${BASE}/api/rooms`)
    return out(await r.json())
  },
)

server.tool(
  'room_state',
  "Get a room's full live state: every vessel with its current world position (x,y in metres, origin = Terra), reference body, status (flight/orbit/landed), and periapsis/apoapsis altitude in metres; plus the player roster (funds, science, milestones achieved). This is how you see everyone's space junk to coordinate it.",
  { room: z.string().describe('Room id, e.g. "frontier" (the public MMO) or a private room code.') },
  async ({ room }) => {
    const r = await fetch(`${BASE}/api/room/${encodeURIComponent(room)}/state`)
    if (!r.ok) return out(`room "${room}" not found or has no players yet (HTTP ${r.status})`)
    return out(await r.json())
  },
)

server.tool(
  'say',
  'Post a chat message into a room as Mission Control — your voice as the AI flight coordinator. Use it to advise players ("Buzz, your periapsis is inside the atmosphere — burn prograde at apoapsis"), call out close approaches between vessels, or suggest a transfer window to Luna.',
  {
    room: z.string().describe('Room id to post into.'),
    text: z.string().describe('The message to send (max 280 chars).'),
    from: z.string().optional().describe('Sender name shown in chat; defaults to "Mission Control".'),
  },
  async ({ room, text, from }) => {
    const r = await fetch(`${BASE}/api/room/${encodeURIComponent(room)}/say`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, text }),
    })
    return out(await r.json())
  },
)

await server.connect(new StdioServerTransport())
console.error(`first-orbit MCP server ready (target ${BASE})`)
