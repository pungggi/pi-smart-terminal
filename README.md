# pi-smart-terminal

Persistent PTY terminal sessions for [pi](https://pi.dev) — a native extension
powered by [smart-terminal-mcp](https://github.com/pungggi/smart-terminal-mcp)'s core.

pi's built-in `bash` tool spawns a fresh shell per command: no state, no
background processes, no interactive programs. This extension replaces it with
**one persistent PTY-backed shell session** shared across the whole conversation
— plus the full `terminal_*` tool family, a live session viewer, and footer status.

## What you get

| Layer | Integration |
|---|---|
| **bash override** | Built-in `bash` runs in a persistent PTY session — cwd, env vars, background processes and REPLs survive across calls. Keeps pi's native rendering, truncation and timeout semantics (pluggable `BashOperations` backend). |
| **terminal tools** | 15 `terminal_*` tools (`terminal_start`, `terminal_exec`, `terminal_read`, `terminal_wait`, `terminal_watch`, `terminal_retry`, `terminal_diff`, …). Extras load on demand via `terminal_tools` using pi-native dynamic tool loading — no meta-tool indirection. |
| **Live overlay** | `/term` opens a real-time viewer of any session: watch agent commands stream in, scroll back, follow the tail (`↑↓/PgUp/PgDn`, `f`, `q`). |
| **Footer status** | `term: ⏵ calm-reef (agent) my/project` — session, cwd drift and busy state at a glance. |
| **Shared shell** | Optional: your `!` commands run in the *same* session the agent uses. |
| **Lifecycle** | Every PTY is killed (process group, Unix) on session shutdown — no orphans when pi exits. |

## Install

```bash
pi install npm:pi-smart-terminal
```

Requirements: Node ≥ 20 and a C++ toolchain for `node-pty` (prebuilt binaries cover
common platforms; on Windows use `npm rebuild node-pty` inside the package if needed).

## Configuration

`~/.pi/agent/smart-terminal.json` (all keys optional):

```json
{
	"overrideBash": true,
	"userBash": false,
	"bashTimeoutMs": 600000,
	"footer": true,
	"defaultShell": null,
	"allToolsActive": false
}
```

| Key | Default | Meaning |
|---|---|---|
| `overrideBash` | `true` | Replace built-in `bash` with the persistent-session backend. |
| `userBash` | `false` | Route user `!` commands through the shared session (opt-in; full-screen tools like `!vim` are better left native). |
| `bashTimeoutMs` | `600000` | Hard cap when the model passes no timeout. |
| `footer` | `true` | Show the footer status line. |
| `defaultShell` | `null` | Force a shell; `null` = auto-detect (`pwsh > powershell > cmd` on Windows, `$SHELL > bash > sh` elsewhere). |
| `allToolsActive` | `false` | Register all 15 tools with full schemas instead of lazy loading extras. |

## How the bash override behaves

- **First call** spawns the agent session and waits for the shell banner
  (~1–2.5 s once).
- **cwd persistence is the point**: `cd` carries over between calls. The
  per-call cwd is only used when (re-)creating a dead session. Watch drift in
  the footer, or reset with `terminal_stop` + a fresh bash call.
- **Parallel bash calls / busy session** (a background command is running):
  transparently falls back to a one-shot stateless execution so the call
  still succeeds.
- **Timeout** (`timeout:N`) and **abort** (Esc → `ctrl+c` to the PTY) map onto
  pi's native error formats; partial output is preserved.
- **Long-running commands** (dev servers): use `terminal_exec` with
  `quietExitMs`, or let a bash call time out — the command keeps running in
  the session; read new output with `terminal_read({ since })`, wait for
  patterns with `terminal_wait` / `terminal_watch`, and watch it live in `/term`.

## Commands

- `/term` — live overlay of a terminal session
- `/terminals` — list active sessions

## Tool catalog

**Active from the start:** `terminal_start`, `terminal_exec`, `terminal_run`,
`terminal_read`, `terminal_write`, `terminal_wait`, `terminal_stop`,
`terminal_list`, plus the `terminal_tools` loader.

**Loaded on demand:** `terminal_run_paged`, `terminal_retry`, `terminal_diff`,
`terminal_resize`, `terminal_send_key`, `terminal_get_history`,
`terminal_write_file`, `terminal_watch`.

Payload shapes are identical to the smart-terminal-mcp tools, so agent habits
transfer 1:1 between pi and MCP clients.

## Relationship to smart-terminal-mcp

This package is the native pi integration of the same core
([smart-terminal-mcp](https://github.com/pungggi/smart-terminal-mcp)): one core,
two adapters. The MCP server remains the portable path for Claude Code, Cursor
and friends; inside pi, this extension goes deeper than MCP can — tool schemas,
dynamic loading, custom UI, lifecycle hooks.

## License

MIT
