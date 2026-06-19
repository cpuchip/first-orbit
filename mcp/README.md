# First Orbit — MCP server

Let an AI buddy (Claude, or any MCP client) help run your space program: see
every player's vessels and orbits, and talk to the room as **Mission Control**.

It's a thin bridge over the game server's read/chat API, so it works against the
live game or a local dev server — no game-internals access, just the same data a
player sees plus the ability to post chat.

## Tools

| Tool | What it does |
|------|--------------|
| `list_rooms` | Active rooms (universes) with player + vessel counts. |
| `room_state` | A room's full live state — every vessel's position (x,y metres), body, status, periapsis/apoapsis, and the roster (funds, science, milestones). |
| `say` | Post a chat message into a room as Mission Control. |

## Setup

```bash
cd mcp
npm install
```

Point it at a game with `FIRST_ORBIT_URL` (default `https://orbit.cpuchip.net`):

```bash
FIRST_ORBIT_URL=http://localhost:8080 node server.mjs   # local dev
```

## Wire it into Claude Code

```bash
claude mcp add first-orbit -- node /abs/path/to/projects/first-orbit/mcp/server.mjs
```

or add to `.mcp.json`:

```json
{
  "mcpServers": {
    "first-orbit": {
      "command": "node",
      "args": ["/abs/path/to/projects/first-orbit/mcp/server.mjs"],
      "env": { "FIRST_ORBIT_URL": "https://orbit.cpuchip.net" }
    }
  }
}
```

Then ask your buddy things like *"What's flying in the frontier room right now?"*
or *"Tell Buzz his apoapsis is too low."* The AI calls `room_state` to see the
junk and `say` to coordinate it.

## How it talks to the game

The game server (`server/index.ts`) exposes:

- `GET /api/rooms` — room list.
- `GET /api/room/:room/state` — vessels (with computed positions) + roster + clock.
- `POST /api/room/:room/say` — `{ from?, text }`, broadcasts a chat line to the room.

CORS is open (`*`) so the bridge can run anywhere. The API is read + chat only —
the AI advises; it doesn't fly anyone's ship.
