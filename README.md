# pi-smart-terminal

A real, persistent shell for [pi](https://pi.dev) — the agent's `bash` tool runs in
a live PTY terminal session instead of a throwaway shell, powered by
[smart-terminal-mcp](https://github.com/pungggi/smart-terminal-mcp)'s core.

## Why

pi's built-in `bash` tool spawns a **fresh shell for every command**. Each call
runs in a vacuum:

```text
bash: cd packages/api && npm test          # 'cd' is lost instantly — so the agent
bash: cd packages/api && npm run build     # must chain && cd ../.. into everything
bash: export API_KEY=...                   # environment gone by the next call
bash: npm run dev                          # background server: output unreachable,
                                           # process dead or orphaned after the call
bash: python                               # REPLs, npm-init prompts, ssh, docker
                                           # login — anything interactive just hangs
```

With pi-smart-terminal, `bash` runs in **one persistent PTY session** — same
shell, same terminal, alive for the whole conversation:

```text
bash: cd packages/api     # the session is now IN packages/api
bash: npm test            # just works — no chaining
bash: export API_KEY=...  # still set on the next call
bash: npm run dev         # keeps running; new output readable at any time
                          #   (terminal_read / terminal_wait / terminal_watch)
/term                     # YOU watch the agent's shell live, as it types
```

In short:

- **State that sticks** — cwd, environment variables and background processes
  survive between calls. The agent stops wasting tokens on `cd` chains and
  absolute paths.
- **Interactive programs work** — REPLs, installers with prompts, `ssh`,
  test-watchers: a real TTY means they behave like they do in your own terminal,
  and the agent can answer prompts with `terminal_write` / `terminal_send_key`.
- **Long-running processes become usable** — start a dev server once, then read
  its output incrementally, wait for a "listening on" line, or watch for errors
  — event-driven, instead of re-dumping logs into the conversation.
- **You can actually watch it** — `/term` is a live viewer of the agent's shell.
  See what the model is doing in real time, scroll its full history, while the
  footer shows session, cwd and busy state at a glance.
- **Nothing leaks** — all sessions are killed (entire process group) when pi
  exits; no orphaned dev servers after a session.

The `terminal_*` tool family adds the controls a persistent shell needs
(`terminal_read`, `terminal_wait`, `terminal_watch`, `terminal_retry`,
`terminal_diff`, …) — payload-identical to the smart-terminal-mcp tools, so
agent habits transfer 1:1 from Claude Code, Cursor & co.

## How it integrates

- **bash override** — built-in `bash` transparently executes in the persistent PTY session (pi's rendering, truncation and timeouts preserved). Falls back to a one-shot shell when the session is busy with a background command.
- **terminal tools** — 15 `terminal_*` tools matching the MCP server; extras load on demand via `terminal_tools` (pi-native dynamic tool loading).
- **`/term`** — live session viewer; **footer** — session, cwd and busy state.
- **Shared shell** — opt-in: your `!` commands run in the agent's session too.
- **Lifecycle** — all PTYs killed (process group) on shutdown; if `node-pty` fails to load, pi starts normally without this extension.

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
