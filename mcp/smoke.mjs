// MCP smoke test — spins up the server as a child over stdio and exercises it
// like a real MCP client. Run with a game server on FIRST_ORBIT_URL.
//   FIRST_ORBIT_URL=http://localhost:9196 node smoke.mjs
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath } from 'node:url'

const BASE = process.env.FIRST_ORBIT_URL ?? 'http://localhost:9196'
let failures = 0
const check = (name, cond, detail = '') => {
  console.log(`${cond ? '  ok' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}

const transport = new StdioClientTransport({
  command: 'node',
  args: [fileURLToPath(new URL('server.mjs', import.meta.url))],
  env: { ...process.env, FIRST_ORBIT_URL: BASE },
})
const client = new Client({ name: 'first-orbit-smoke', version: '1.0.0' })
await client.connect(transport)

const { tools } = await client.listTools()
const names = tools.map((t) => t.name)
check('lists the 3 tools', ['list_rooms', 'room_state', 'say'].every((n) => names.includes(n)), names.join(','))

const rooms = await client.callTool({ name: 'list_rooms', arguments: {} })
const roomsText = rooms.content[0].text
check('list_rooms returns the frontier room', roomsText.includes('frontier'), roomsText.slice(0, 80))

const state = await client.callTool({ name: 'room_state', arguments: { room: 'frontier' } })
check('room_state returns vessels + roster', /vessels/.test(state.content[0].text) && /players/.test(state.content[0].text))

const said = await client.callTool({ name: 'say', arguments: { room: 'frontier', text: 'MCP smoke: all systems nominal.', from: 'Smoke' } })
check('say posts ok', /"ok":\s*true/.test(said.content[0].text), said.content[0].text)

await client.close()
console.log(`\n${failures === 0 ? 'MCP smoke green ✓' : failures + ' failed'}`)
process.exit(failures === 0 ? 0 : 1)
