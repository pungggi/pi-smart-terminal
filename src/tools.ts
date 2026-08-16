/**
 * terminal_* tools for pi, backed by the shared SessionManager.
 *
 * Mirrors the smart-terminal-mcp tool surface, but as native pi tools:
 * full TypeBox schemas, pi dynamic tool loading instead of the
 * terminal_extra meta-tool, and the same JSON payload shapes agents
 * already know from the MCP variants.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";

import {
	DEFAULT_EXEC_MAX_LINES,
	DEFAULT_HISTORY_LIMIT,
	DEFAULT_MAX_OUTPUT_BYTES,
	DEFAULT_PAGE_SIZE,
	DEFAULT_READ_MAX_LINES,
	DEFAULT_TIMEOUT_MS,
	SUPPORTED_KEYS,
	execAndDiff,
	execWithRetry,
	paginateOutput,
	runCommand,
	summarizeCommandOutput,
} from "./core.js";
import { clearAgentSession, runtime } from "./runtime.js";
import { assertPagedCommandIsReadOnly } from "./command-guards.js";

/** Core tools are active from the start. */
export const CORE_TOOLS = [
	"terminal_start",
	"terminal_exec",
	"terminal_run",
	"terminal_read",
	"terminal_write",
	"terminal_wait",
	"terminal_stop",
	"terminal_list",
] as const;

/** Extra tools load on demand via the terminal_tools loader (pi-native). */
export const EXTRA_TOOLS = [
	"terminal_run_paged",
	"terminal_retry",
	"terminal_diff",
	"terminal_resize",
	"terminal_send_key",
	"terminal_get_history",
	"terminal_write_file",
	"terminal_watch",
] as const;

export const ALL_TOOL_NAMES = [...CORE_TOOLS, ...EXTRA_TOOLS] as const;

import * as coreModule from "./core.js";

function manager() {
	if (!runtime.manager) {
		runtime.manager = new coreModule.SessionManager();
	}
	return runtime.manager;
}

function jsonContent(payload: unknown) {
	return { content: [{ type: "text" as const, text: JSON.stringify(payload) }], details: {} };
}

const num = (opts: { min: number; max?: number; description?: string }) =>
	Type.Optional(Type.Number({ ...opts }));

export function registerTerminalTools(pi: ExtensionAPI): void {
	// --- terminal_start ---
	pi.registerTool({
		name: "terminal_start",
		label: "Terminal start",
		description: "Start a new interactive terminal session (auto-detects the shell). Returns sessionId.",
		promptSnippet: "Start persistent interactive terminal sessions",
		parameters: Type.Object({
			shell: Type.Optional(Type.String({ description: "Shell executable; omit to auto-detect" })),
			cols: num({ min: 20, max: 500 }),
			rows: num({ min: 5, max: 200 }),
			cwd: Type.Optional(Type.String()),
			name: Type.Optional(Type.String()),
			env: Type.Optional(Type.Record(Type.String(), Type.String())),
		}),
		async execute(_id, params) {
			try {
				const session = await manager().create({
					shell: params.shell,
					cols: params.cols ?? 120,
					rows: params.rows ?? 30,
					cwd: params.cwd,
					name: params.name,
					env: params.env,
				});
				const banner = await session.waitForBanner();
				return jsonContent({
					sessionId: session.id,
					shell: session.shell,
					shellType: session.shellType,
					cwd: session.cwd,
					banner: banner || "(no banner)",
				});
			} catch (err) {
				const hint = params.shell
					? "\n\nHint: call terminal_start with NO shell parameter to auto-detect the best available shell."
					: "";
				throw new Error(`${(err as Error).message}${hint}`);
			}
		},
	});

	// --- terminal_exec ---
	pi.registerTool({
		name: "terminal_exec",
		label: "Terminal exec",
		description:
			"Run a command in a session and wait for completion (marker-based). Reports exit code and current directory.",
		promptSnippet: "Run commands in a persistent terminal session",
		parameters: Type.Object({
			sessionId: Type.String(),
			command: Type.String(),
			timeout: num({ min: 1000, max: 600000 }),
			maxLines: num({ min: 10, max: 10000 }),
			quietExitMs: num({ min: 500, max: 600000, description: "Exit if silent for N ms" }),
			minOutputBytes: num({ min: 0, description: "Min bytes before quiet exit" }),
		}),
		async execute(_id, params) {
			const session = manager().get(params.sessionId);
			const result = await session.exec({
				command: params.command,
				timeout: params.timeout ?? 30000,
				maxLines: params.maxLines ?? DEFAULT_EXEC_MAX_LINES,
				quietExitMs: params.quietExitMs,
				minOutputBytes: params.minOutputBytes ?? 1,
			});
			return jsonContent(result);
		},
	});

	// --- terminal_run ---
	pi.registerTool({
		name: "terminal_run",
		label: "Terminal run",
		description: "Run a binary directly (no PTY, no session). shell=true for built-ins/pipes/redirects.",
		promptSnippet: "Run one-shot binaries directly with structured output",
		parameters: Type.Object({
			cmd: Type.String(),
			args: Type.Optional(Type.Array(Type.String())),
			cwd: Type.Optional(Type.String()),
			timeout: num({ min: 1000, max: 600000 }),
			maxOutputBytes: num({ min: 1024, max: 1048576 }),
			parse: Type.Optional(Type.Boolean({ description: "Parse structured output" })),
			parseOnly: Type.Optional(Type.Boolean({ description: "Omit raw when parsed" })),
			summary: Type.Optional(Type.Boolean()),
			successExitCode: Type.Optional(Type.Union([Type.Number(), Type.Null()], { description: "null=any" })),
			successFile: Type.Optional(Type.String()),
			successFilePattern: Type.Optional(Type.String({ description: "Regex" })),
			shell: Type.Optional(Type.Boolean({ description: "Run via system shell" })),
		}),
		async execute(_id, params) {
			const result = await runCommand({
				cmd: params.cmd,
				args: params.args ?? [],
				cwd: params.cwd,
				timeout: params.timeout ?? DEFAULT_TIMEOUT_MS,
				maxOutputBytes: params.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
				parse: params.parse ?? true,
				parseOnly: params.parseOnly ?? false,
				summary: params.summary ?? false,
				successExitCode: params.successExitCode ?? 0,
				successFile: params.successFile,
				successFilePattern: params.successFilePattern,
				shell: params.shell ?? false,
			});
			return jsonContent(result);
		},
	});

	// --- terminal_read ---
	pi.registerTool({
		name: "terminal_read",
		label: "Terminal read",
		description: "Read new output from a session. Pass `since` (byte position) for incremental reads.",
		promptSnippet: "Read incremental output from terminal sessions",
		parameters: Type.Object({
			sessionId: Type.String(),
			timeout: num({ min: 500, max: 300000 }),
			idleTimeout: num({ min: 100, max: 10000, description: "Must be < timeout" }),
			maxLines: num({ min: 10, max: 10000 }),
			since: num({ min: 0, description: "Byte position for incremental read" }),
		}),
		async execute(_id, params) {
			const session = manager().get(params.sessionId);
			const result = await session.read({
				timeout: params.timeout ?? 30000,
				idleTimeout: params.idleTimeout ?? 500,
				maxLines: params.maxLines ?? DEFAULT_READ_MAX_LINES,
				since: params.since,
			});
			return jsonContent(result);
		},
	});

	// --- terminal_write ---
	pi.registerTool({
		name: "terminal_write",
		label: "Terminal write",
		description: "Write raw data to a session (prompts, REPLs). Interprets \\r \\n \\t escapes.",
		promptSnippet: "Write raw input into terminal sessions",
		parameters: Type.Object({
			sessionId: Type.String(),
			data: Type.String(),
		}),
		async execute(_id, params) {
			const session = manager().get(params.sessionId);
			session.write(
				params.data.replace(/\\r/g, "\r").replace(/\\n/g, "\n").replace(/\\t/g, "\t"),
			);
			return jsonContent({ success: true, sessionId: params.sessionId });
		},
	});

	// --- terminal_wait ---
	pi.registerTool({
		name: "terminal_wait",
		label: "Terminal wait",
		description: "Wait for a pattern to appear in session output (replaces poll loops).",
		promptSnippet: "Wait for patterns in terminal output instead of polling",
		parameters: Type.Object({
			sessionId: Type.String(),
			pattern: Type.String(),
			timeout: num({ min: 1000, max: 600000 }),
			returnMode: Type.Optional(StringEnum(["tail", "full", "match-only"] as const)),
			tailLines: num({ min: 1, max: 1000 }),
		}),
		async execute(_id, params) {
			const session = manager().get(params.sessionId);
			const result = await session.waitForPattern({
				pattern: params.pattern,
				timeout: params.timeout ?? 30000,
				returnMode: params.returnMode ?? "tail",
				tailLines: params.tailLines ?? 50,
			});
			return jsonContent(result);
		},
	});

	// --- terminal_stop ---
	pi.registerTool({
		name: "terminal_stop",
		label: "Terminal stop",
		description: "Stop a session. Optionally return a tail snapshot and/or write a transcript to disk.",
		promptSnippet: "Stop terminal sessions, optionally snapshotting output",
		parameters: Type.Object({
			sessionId: Type.String(),
			snapshotLines: num({ min: 0, max: 2000, description: "Return last N lines (0 = none)" }),
			transcriptPath: Type.Optional(Type.String({ description: "Write history to this path" })),
		}),
		async execute(_id, params) {
			const m = manager();
			const session = m.get(params.sessionId);
			const snapshotLines = params.snapshotLines ?? 0;

			let snapshot: { text: string; lineCount: number; totalLines: number } | null = null;
			if (snapshotLines > 0) {
				const hist = session.getHistory({ offset: 0, limit: snapshotLines, format: "text" });
				snapshot = {
					text: hist.text,
					lineCount: hist.returnedTo - hist.returnedFrom,
					totalLines: hist.totalLines,
				};
			}

			let transcript: { path: string; bytes: number } | null = null;
			if (params.transcriptPath) {
				const { writeFile, mkdir } = await import("node:fs/promises");
				const { resolve, dirname } = await import("node:path");
				const absolutePath = resolve(params.transcriptPath);
				await mkdir(dirname(absolutePath), { recursive: true });
				const full = session.getHistory({ offset: 0, limit: 10000, format: "text" });
				await writeFile(absolutePath, full.text, "utf-8");
				transcript = { path: absolutePath, bytes: Buffer.byteLength(full.text) };
			}

			m.stop(params.sessionId);
			clearAgentSession(params.sessionId);
			return jsonContent({
				success: true,
				message: `Session ${params.sessionId} stopped.`,
				...(snapshot && { snapshot }),
				...(transcript && { transcript }),
			});
		},
	});

	// --- terminal_list ---
	pi.registerTool({
		name: "terminal_list",
		label: "Terminal list",
		description: "List active terminal sessions (id, cwd, busy, alive).",
		promptSnippet: "List active terminal sessions",
		parameters: Type.Object({
			verbose: Type.Optional(Type.Boolean()),
		}),
		async execute(_id, params) {
			const sessions = manager().list({ verbose: params.verbose ?? true });
			return jsonContent({ sessions, count: sessions.length });
		},
	});

	// ---- Extra tools (inactive until loaded via terminal_tools) ----

	pi.registerTool({
		name: "terminal_run_paged",
		label: "Terminal run paged",
		description:
			"Run a read-only command (git branch/diff/log/ls-files/remote/rev-parse/status, tasklist, where, which) and return one page of output.",
		parameters: Type.Object({
			cmd: Type.String(),
			args: Type.Optional(Type.Array(Type.String())),
			cwd: Type.Optional(Type.String()),
			timeout: num({ min: 1000, max: 600000 }),
			maxOutputBytes: num({ min: 1024, max: 1048576 }),
			page: num({ min: 0 }),
			pageSize: num({ min: 1, max: 1000 }),
			summary: Type.Optional(Type.Boolean()),
		}),
		async execute(_id, params) {
			assertPagedCommandIsReadOnly(params.cmd, params.args ?? []);
			const result = await runCommand({
				cmd: params.cmd,
				args: params.args ?? [],
				cwd: params.cwd,
				timeout: params.timeout ?? DEFAULT_TIMEOUT_MS,
				maxOutputBytes: params.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
				parse: params.summary ?? false,
			});
			const pagination = paginateOutput(result.stdout.raw, {
				page: params.page ?? 0,
				pageSize: params.pageSize ?? DEFAULT_PAGE_SIZE,
			});
			return jsonContent({
				...result,
				stdout: { raw: pagination.pageText, parsed: null },
				pageInfo: {
					page: pagination.page,
					pageSize: pagination.pageSize,
					totalLines: pagination.totalLines,
					hasNext: pagination.hasNext,
				},
			});
		},
	});

	pi.registerTool({
		name: "terminal_retry",
		label: "Terminal retry",
		description: "Retry a command in a session with bounded backoff and optional success matching.",
		parameters: Type.Object({
			sessionId: Type.String(),
			command: Type.String(),
			maxRetries: num({ min: 0, max: 10 }),
			backoff: Type.Optional(StringEnum(["fixed", "exponential", "linear"] as const)),
			delayMs: num({ min: 10, max: 60000 }),
			timeout: num({ min: 1000, max: 600000 }),
			maxLines: num({ min: 10, max: 10000 }),
			successExitCode: Type.Optional(Type.Union([Type.Number(), Type.Null()], { description: "null=any" })),
			successPattern: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: "Regex" })),
		}),
		async execute(_id, params) {
			const session = manager().get(params.sessionId);
			const result = await execWithRetry(session, {
				command: params.command,
				maxRetries: params.maxRetries ?? 3,
				backoff: params.backoff ?? "exponential",
				delayMs: params.delayMs ?? 1000,
				timeout: params.timeout ?? 30000,
				maxLines: params.maxLines ?? DEFAULT_EXEC_MAX_LINES,
				successExitCode: params.successExitCode ?? 0,
				successPattern: params.successPattern ?? null,
			});
			return jsonContent(result);
		},
	});

	pi.registerTool({
		name: "terminal_diff",
		label: "Terminal diff",
		description: "Run two commands in a session and return a unified diff of their outputs.",
		parameters: Type.Object({
			sessionId: Type.String(),
			commandA: Type.String(),
			commandB: Type.String(),
			timeout: num({ min: 1000, max: 600000 }),
			maxLines: num({ min: 10, max: 10000 }),
			contextLines: num({ min: 0, max: 20 }),
		}),
		async execute(_id, params) {
			const session = manager().get(params.sessionId);
			const result = await execAndDiff(session, {
				commandA: params.commandA,
				commandB: params.commandB,
				timeout: params.timeout ?? 30000,
				maxLines: params.maxLines ?? DEFAULT_EXEC_MAX_LINES,
				contextLines: params.contextLines ?? 3,
			});
			return jsonContent(result);
		},
	});

	pi.registerTool({
		name: "terminal_resize",
		label: "Terminal resize",
		description: `Resize a session's terminal dimensions.`,
		parameters: Type.Object({
			sessionId: Type.String(),
			cols: Type.Number({ minimum: 20, maximum: 500 }),
			rows: Type.Number({ minimum: 5, maximum: 200 }),
		}),
		async execute(_id, params) {
			const session = manager().get(params.sessionId);
			session.resize(params.cols, params.rows);
			return jsonContent({ success: true, cols: params.cols, rows: params.rows });
		},
	});

	pi.registerTool({
		name: "terminal_send_key",
		label: "Terminal send key",
		description: `Send a special key to a session. Supported: ${SUPPORTED_KEYS.join(", ")}.`,
		parameters: Type.Object({
			sessionId: Type.String(),
			key: Type.String(),
		}),
		async execute(_id, params) {
			const session = manager().get(params.sessionId);
			session.sendKey(params.key);
			return jsonContent({ success: true, key: params.key });
		},
	});

	pi.registerTool({
		name: "terminal_get_history",
		label: "Terminal history",
		description: "Get past output from a session without consuming it (offset = lines from the end).",
		parameters: Type.Object({
			sessionId: Type.String(),
			offset: num({ min: 0 }),
			maxLines: num({ min: 1, max: 10000 }),
			format: Type.Optional(StringEnum(["lines", "text"] as const)),
		}),
		async execute(_id, params) {
			const session = manager().get(params.sessionId);
			const result = session.getHistory({
				offset: params.offset ?? 0,
				limit: params.maxLines ?? DEFAULT_HISTORY_LIMIT,
				format: params.format ?? "lines",
			});
			return jsonContent({ sessionId: params.sessionId, ...result });
		},
	});

	pi.registerTool({
		name: "terminal_write_file",
		label: "Terminal write file",
		description: "Write content to a file relative to a session's cwd (respects the session's drifted directory).",
		parameters: Type.Object({
			sessionId: Type.String(),
			path: Type.String(),
			content: Type.String(),
			encoding: Type.Optional(StringEnum(["utf-8", "ascii", "base64", "hex", "latin1"] as const)),
			append: Type.Optional(Type.Boolean()),
		}),
		async execute(_id, params) {
			const { writeFile, appendFile, mkdir } = await import("node:fs/promises");
			const { resolve, dirname } = await import("node:path");
			const session = manager().get(params.sessionId);
			const absolutePath = resolve(session.cwd, params.path);
			await mkdir(dirname(absolutePath), { recursive: true });
			const encoding = (params.encoding ?? "utf-8") as BufferEncoding;
			if (params.append ?? false) await appendFile(absolutePath, params.content, encoding);
			else await writeFile(absolutePath, params.content, encoding);
			return jsonContent({
				success: true,
				path: absolutePath,
				size: Buffer.byteLength(params.content, encoding),
				append: params.append ?? false,
			});
		},
	});

	pi.registerTool({
		name: "terminal_watch",
		label: "Terminal watch",
		description: "Event-driven monitor: returns when a trigger pattern matches, output goes quiet, timeout, or the session exits.",
		parameters: Type.Object({
			sessionId: Type.String(),
			triggers: Type.Array(
				Type.Object({
					id: Type.String({ description: "Trigger label, returned in response" }),
					pattern: Type.String({ description: "Regex or literal pattern" }),
					isRegex: Type.Optional(Type.Boolean()),
					cooldownMs: num({ min: 0, description: "Min ms between matches" }),
				}),
				{ minItems: 1, maxItems: 10 },
			),
			timeout: num({ min: 1000, max: 3600000 }),
			quietExitMs: num({ min: 0, description: "Exit if no output for N ms" }),
			contextLines: num({ min: 0, max: 50, description: "Context lines before match" }),
			since: num({ min: 0, description: "Match after byte position" }),
		}),
		async execute(_id, params) {
			const session = manager().get(params.sessionId);
			const result = await session.watch({
				triggers: params.triggers,
				timeout: params.timeout ?? 60000,
				quietExitMs: params.quietExitMs,
				contextLines: params.contextLines ?? 3,
				since: params.since,
			});
			return jsonContent(result);
		},
	});

	// --- terminal_tools: pi-native loader (replaces the MCP terminal_extra meta-tool) ---
	pi.registerTool({
		name: "terminal_tools",
		label: "Terminal tools",
		description: `Load additional terminal tools on demand. Available: ${EXTRA_TOOLS.join(", ")}.`,
		promptSnippet: "Load extra terminal tools (paged runs, retry, diff, watch, history, …)",
		promptGuidelines: [
			"Use terminal_tools to activate extra terminal tools (terminal_retry, terminal_diff, terminal_watch, terminal_run_paged, terminal_get_history, terminal_resize, terminal_send_key, terminal_write_file) before calling them.",
		],
		parameters: Type.Object({
			list: Type.Optional(Type.Boolean({ description: "List loadable tools with descriptions" })),
			names: Type.Optional(Type.Array(Type.String(), { description: "Tool names to activate" })),
		}),
		async execute(_id, params) {
			if (params.list) {
				const catalog = EXTRA_TOOLS.map((name) => {
					const tool = pi.getAllTools().find((t) => t.name === name);
					return { name, description: tool?.description ?? "" };
				});
				return jsonContent({ tools: catalog });
			}

			const requested = params.names ?? [];
			const invalid = requested.filter((n) => !(EXTRA_TOOLS as readonly string[]).includes(n));
			if (invalid.length > 0) {
				throw new Error(`Unknown or non-loadable tools: ${invalid.join(", ")}. Available: ${EXTRA_TOOLS.join(", ")}`);
			}

			const active = pi.getActiveTools();
			const added = requested.filter((n) => !active.includes(n));
			if (added.length > 0) {
				pi.setActiveTools([...new Set([...active, ...added])]);
			}

			return jsonContent({
				activated: added,
				alreadyActive: requested.filter((n) => active.includes(n)),
			});
		},
	});
}

/**
 * Restrict the initially active tool set: keep core + loader, drop extras.
 * Called on session_start; purely subtractive w.r.t. our own tools.
 */
export function applyInitialActiveTools(pi: ExtensionAPI, allActive: boolean): void {
	if (allActive) return;
	const active = pi.getActiveTools();
	const extras = new Set<string>(EXTRA_TOOLS);
	const filtered = active.filter((name) => !extras.has(name));
	if (filtered.length !== active.length) {
		pi.setActiveTools(filtered);
	}
}
