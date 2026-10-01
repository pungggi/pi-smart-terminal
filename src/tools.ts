/**
 * terminal_* tools for pi, backed by the shared SessionManager.
 *
 * Mirrors the smart-terminal-mcp tool surface, but as native pi tools:
 * full TypeBox schemas, pi dynamic tool loading instead of the
 * terminal_extra meta-tool, and the same JSON payload shapes agents
 * already know from the MCP variants.
 *
 * pi 0.99+ integration:
 *  - every tool declares `outputSchema` and returns `structuredContent`,
 *    so codemode scripts and nested ctx.executeTool() callers receive
 *    typed JSON instead of parsing text content;
 *  - all tools share the `smart-terminal` namespace (searchTools() /
 *    describeNamespace() discover them as one group);
 *  - `annotations` carry MCP-style hints (read-only observers vs the
 *    destructive terminal_stop) for permission extensions;
 *  - extra tools register with exposure "deferred": callable by codemode
 *    scripts and findable by the built-in tool_search at any time, but
 *    never auto-declared to the model. The terminal_tools loader (and
 *    defaultTools/--tools pins) still activate them on demand.
 */

import type { AgentToolResult, ExtensionAPI, ToolAnnotations, ToolNamespace } from "@earendil-works/pi-coding-agent";
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

/** Extra tools: exposure "deferred" — codemode-callable, tool_search-findable, activated on demand. */
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

/** Namespace for codemode discovery (searchTools / describeNamespace). */
export const TERMINAL_NAMESPACE: ToolNamespace = {
	name: "smart-terminal",
	description:
		"Persistent PTY terminal sessions: shell cwd, environment and background processes survive across tool calls.",
	instructions: [
		"Persistent PTY terminal sessions. One session = one live shell: cwd, environment variables and background processes persist across calls.",
		"Start with terminal_start once, then pass the returned sessionId to terminal_exec / terminal_read / terminal_write.",
		"terminal_read accepts `since` (byte position from the previous read) for incremental output; re-dumping whole logs wastes context.",
		"Long-running processes (dev servers, watchers): start them, then poll incrementally with terminal_read, or block until a pattern with terminal_wait / terminal_watch.",
		"terminal_stop kills the whole process group of a session; use it to clean up dev servers.",
	].join("\n"),
};

/** MCP-style hints for permission extensions. */
const ANNOTATION_READ_ONLY: ToolAnnotations = { readOnlyHint: true };
const ANNOTATION_MUTATING: ToolAnnotations = { destructiveHint: false, openWorldHint: false };
const ANNOTATION_EXEC: ToolAnnotations = { destructiveHint: false, openWorldHint: true };
const ANNOTATION_DESTRUCTIVE: ToolAnnotations = { destructiveHint: true, openWorldHint: true };

import * as coreModule from "./core.js";

function manager() {
	if (!runtime.manager) {
		runtime.manager = new coreModule.SessionManager();
	}
	return runtime.manager;
}

/**
 * Model-facing content stays the JSON text (unchanged behavior); programmatic
 * callers (codemode scripts, nested ctx.executeTool) additionally receive the
 * payload as structuredContent matching the tool's outputSchema.
 */
function structured(payload: unknown, isError = false): AgentToolResult {
	const result: AgentToolResult = {
		content: [{ type: "text", text: JSON.stringify(payload) }],
		details: {},
		structuredContent: payload as never,
	};
	if (isError) result.isError = true;
	return result;
}

const num = (opts: { min: number; max?: number; description?: string }) =>
	Type.Optional(Type.Number({ ...opts }));

// --- Shared output schema fragments (mirror smart-terminal-mcp result types) ---

const execResultSchema = Type.Object({
	output: Type.String(),
	exitCode: Type.Union([Type.Number(), Type.Null()]),
	cwd: Type.Union([Type.String(), Type.Null()]),
	timedOut: Type.Boolean(),
	quietExited: Type.Optional(Type.Boolean()),
	hint: Type.Optional(Type.String()),
});

const runCommandResultSchema = Type.Object({
	cmd: Type.String(),
	args: Type.Array(Type.String()),
	exitCode: Type.Union([Type.Number(), Type.Null()]),
	timedOut: Type.Boolean(),
	killed: Type.Boolean(),
	durationMs: Type.Number(),
	stdout: Type.Object({ raw: Type.String(), parsed: Type.Unknown() }),
	stderr: Type.Object({ raw: Type.String(), parsed: Type.Unknown() }),
	parsing: Type.Optional(Type.Union([Type.Object({ parser: Type.String() }), Type.Null()])),
	summary: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	success: Type.Optional(Type.Object({ ok: Type.Boolean(), reason: Type.String() })),
});

const sessionInfoSchema = Type.Object({
	id: Type.String(),
	name: Type.Union([Type.String(), Type.Null()]),
	cwd: Type.String(),
	alive: Type.Boolean(),
	busy: Type.Boolean(),
	shell: Type.Optional(Type.String()),
	shellType: Type.Optional(Type.String()),
	cols: Type.Optional(Type.Number()),
	rows: Type.Optional(Type.Number()),
	createdAt: Type.Optional(Type.String()),
	lastActivity: Type.Optional(Type.String()),
	idleSeconds: Type.Optional(Type.Number()),
});

export function registerTerminalTools(pi: ExtensionAPI): void {
	// --- terminal_start ---
	pi.registerTool({
		name: "terminal_start",
		label: "Terminal start",
		description: "Start a new interactive terminal session (auto-detects the shell). Returns sessionId.",
		promptSnippet: "Start persistent interactive terminal sessions",
		namespace: TERMINAL_NAMESPACE,
		annotations: ANNOTATION_MUTATING,
		outputSchema: Type.Object({
			sessionId: Type.String(),
			shell: Type.String(),
			shellType: Type.String(),
			cwd: Type.String(),
			banner: Type.String(),
		}),
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
				return structured({
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
		namespace: TERMINAL_NAMESPACE,
		annotations: ANNOTATION_EXEC,
		outputSchema: execResultSchema,
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
			return structured(result);
		},
	});

	// --- terminal_run ---
	pi.registerTool({
		name: "terminal_run",
		label: "Terminal run",
		description: "Run a binary directly (no PTY, no session). shell=true for built-ins/pipes/redirects.",
		promptSnippet: "Run one-shot binaries directly with structured output",
		namespace: TERMINAL_NAMESPACE,
		annotations: ANNOTATION_EXEC,
		outputSchema: runCommandResultSchema,
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
			// Non-zero exit / timeout / failed success-criteria: an error result
			// for the model (like pi's built-in bash), while scripts still get
			// the full structuredContent.
			const failed = result.success ? !result.success.ok : false;
			return structured(result, failed);
		},
	});

	// --- terminal_read ---
	pi.registerTool({
		name: "terminal_read",
		label: "Terminal read",
		description: "Read new output from a session. Pass `since` (byte position) for incremental reads.",
		promptSnippet: "Read incremental output from terminal sessions",
		namespace: TERMINAL_NAMESPACE,
		annotations: ANNOTATION_READ_ONLY,
		outputSchema: Type.Object({
			output: Type.String(),
			timedOut: Type.Boolean(),
			position: Type.Number(),
			truncated: Type.Optional(Type.Boolean()),
		}),
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
			return structured(result);
		},
	});

	// --- terminal_write ---
	pi.registerTool({
		name: "terminal_write",
		label: "Terminal write",
		description: "Write raw data to a session (prompts, REPLs). Interprets \\r \\n \\t escapes.",
		promptSnippet: "Write raw input into terminal sessions",
		namespace: TERMINAL_NAMESPACE,
		annotations: ANNOTATION_EXEC,
		outputSchema: Type.Object({
			success: Type.Boolean(),
			sessionId: Type.String(),
		}),
		parameters: Type.Object({
			sessionId: Type.String(),
			data: Type.String(),
		}),
		async execute(_id, params) {
			const session = manager().get(params.sessionId);
			session.write(
				params.data.replace(/\\r/g, "\r").replace(/\\n/g, "\n").replace(/\\t/g, "\t"),
			);
			return structured({ success: true, sessionId: params.sessionId });
		},
	});

	// --- terminal_wait ---
	pi.registerTool({
		name: "terminal_wait",
		label: "Terminal wait",
		description: "Wait for a pattern to appear in session output (replaces poll loops).",
		promptSnippet: "Wait for patterns in terminal output instead of polling",
		namespace: TERMINAL_NAMESPACE,
		annotations: ANNOTATION_READ_ONLY,
		outputSchema: Type.Object({
			output: Type.String(),
			matched: Type.Boolean(),
			timedOut: Type.Boolean(),
		}),
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
			// The pattern never appeared: report failure (with the tail as data).
			return structured(result, !result.matched);
		},
	});

	// --- terminal_stop ---
	pi.registerTool({
		name: "terminal_stop",
		label: "Terminal stop",
		description: "Stop a session. Optionally return a tail snapshot and/or write a transcript to disk.",
		promptSnippet: "Stop terminal sessions, optionally snapshotting output",
		namespace: TERMINAL_NAMESPACE,
		annotations: ANNOTATION_DESTRUCTIVE,
		outputSchema: Type.Object({
			success: Type.Boolean(),
			message: Type.String(),
			snapshot: Type.Optional(
				Type.Object({ text: Type.String(), lineCount: Type.Number(), totalLines: Type.Number() }),
			),
			transcript: Type.Optional(Type.Object({ path: Type.String(), bytes: Type.Number() })),
		}),
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
			return structured({
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
		namespace: TERMINAL_NAMESPACE,
		annotations: ANNOTATION_READ_ONLY,
		outputSchema: Type.Object({
			sessions: Type.Array(sessionInfoSchema),
			count: Type.Number(),
		}),
		parameters: Type.Object({
			verbose: Type.Optional(Type.Boolean()),
		}),
		async execute(_id, params) {
			const sessions = manager().list({ verbose: params.verbose ?? true });
			return structured({ sessions, count: sessions.length });
		},
	});

	// ---- Extra tools: exposure "deferred" — never auto-declared to the model;
	// ---- callable by codemode scripts, findable by tool_search, activated by
	// ---- the terminal_tools loader or defaultTools/--tools pins. ----

	pi.registerTool({
		name: "terminal_run_paged",
		label: "Terminal run paged",
		description:
			"Run a read-only command (git branch/diff/log/ls-files/remote/rev-parse/status, tasklist, where, which) and return one page of output.",
		namespace: TERMINAL_NAMESPACE,
		annotations: ANNOTATION_READ_ONLY,
		exposure: "deferred",
		outputSchema: Type.Intersect([
			runCommandResultSchema,
			Type.Object({
				pageInfo: Type.Object({
					page: Type.Number(),
					pageSize: Type.Number(),
					totalLines: Type.Number(),
					hasNext: Type.Boolean(),
				}),
			}),
		]),
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
			return structured({
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
		namespace: TERMINAL_NAMESPACE,
		annotations: ANNOTATION_EXEC,
		exposure: "deferred",
		outputSchema: Type.Intersect([
			execResultSchema,
			Type.Object({
				attempts: Type.Number(),
				retryLog: Type.Array(Type.String()),
			}),
		]),
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
			return structured(result);
		},
	});

	pi.registerTool({
		name: "terminal_diff",
		label: "Terminal diff",
		description: "Run two commands in a session and return a unified diff of their outputs.",
		namespace: TERMINAL_NAMESPACE,
		annotations: ANNOTATION_EXEC,
		exposure: "deferred",
		outputSchema: Type.Object({
			commandA: Type.String(),
			commandB: Type.String(),
			diff: Type.String(),
			changed: Type.Boolean(),
			stats: Type.Object({ added: Type.Number(), removed: Type.Number() }),
		}),
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
			return structured(result);
		},
	});

	pi.registerTool({
		name: "terminal_resize",
		label: "Terminal resize",
		description: `Resize a session's terminal dimensions.`,
		namespace: TERMINAL_NAMESPACE,
		annotations: ANNOTATION_MUTATING,
		exposure: "deferred",
		outputSchema: Type.Object({
			success: Type.Boolean(),
			cols: Type.Number(),
			rows: Type.Number(),
		}),
		parameters: Type.Object({
			sessionId: Type.String(),
			cols: Type.Number({ minimum: 20, maximum: 500 }),
			rows: Type.Number({ minimum: 5, maximum: 200 }),
		}),
		async execute(_id, params) {
			const session = manager().get(params.sessionId);
			session.resize(params.cols, params.rows);
			return structured({ success: true, cols: params.cols, rows: params.rows });
		},
	});

	pi.registerTool({
		name: "terminal_send_key",
		label: "Terminal send key",
		description: `Send a special key to a session. Supported: ${SUPPORTED_KEYS.join(", ")}.`,
		namespace: TERMINAL_NAMESPACE,
		annotations: ANNOTATION_EXEC,
		exposure: "deferred",
		outputSchema: Type.Object({
			success: Type.Boolean(),
			key: Type.String(),
		}),
		parameters: Type.Object({
			sessionId: Type.String(),
			key: Type.String(),
		}),
		async execute(_id, params) {
			const session = manager().get(params.sessionId);
			session.sendKey(params.key);
			return structured({ success: true, key: params.key });
		},
	});

	pi.registerTool({
		name: "terminal_get_history",
		label: "Terminal history",
		description: "Get past output from a session without consuming it (offset = lines from the end).",
		namespace: TERMINAL_NAMESPACE,
		annotations: ANNOTATION_READ_ONLY,
		exposure: "deferred",
		outputSchema: Type.Union([
			Type.Object({
				sessionId: Type.String(),
				lines: Type.Array(Type.String()),
				totalLines: Type.Number(),
				returnedFrom: Type.Number(),
				returnedTo: Type.Number(),
			}),
			Type.Object({
				sessionId: Type.String(),
				text: Type.String(),
				totalLines: Type.Number(),
				returnedFrom: Type.Number(),
				returnedTo: Type.Number(),
			}),
		]),
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
			return structured({ sessionId: params.sessionId, ...result });
		},
	});

	pi.registerTool({
		name: "terminal_write_file",
		label: "Terminal write file",
		description: "Write content to a file relative to a session's cwd (respects the session's drifted directory).",
		namespace: TERMINAL_NAMESPACE,
		annotations: ANNOTATION_DESTRUCTIVE,
		exposure: "deferred",
		outputSchema: Type.Object({
			success: Type.Boolean(),
			path: Type.String(),
			size: Type.Number(),
			append: Type.Boolean(),
		}),
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
			return structured({
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
		namespace: TERMINAL_NAMESPACE,
		annotations: ANNOTATION_READ_ONLY,
		exposure: "deferred",
		outputSchema: Type.Object({
			reason: StringEnum(["trigger", "quiet", "timeout", "exit"] as const),
			triggerId: Type.Optional(Type.String()),
			matchedLine: Type.Optional(Type.String()),
			context: Type.Optional(Type.Array(Type.String())),
			position: Type.Number(),
			timedOut: Type.Boolean(),
		}),
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
			// Nothing matched within the window: failure with the tail as data.
			return structured(result, result.reason === "timeout");
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
		namespace: TERMINAL_NAMESPACE,
		annotations: ANNOTATION_MUTATING,
		outputSchema: Type.Union([
			Type.Object({ tools: Type.Array(Type.Object({ name: Type.String(), description: Type.String() })) }),
			Type.Object({
				activated: Type.Array(Type.String()),
				alreadyActive: Type.Array(Type.String()),
			}),
		]),
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
				return structured({ tools: catalog });
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

			return structured({
				activated: added,
				alreadyActive: requested.filter((n) => active.includes(n)),
			});
		},
	});
}

/**
 * Initial active-set policy. Extra tools are registered with exposure
 * "deferred", so they are never auto-declared to the model:
 *  - default: leave them dormant (codemode scripts and tool_search still
 *    reach them) — a user's own pin (defaultTools: ["+terminal_watch"],
 *    --tools, resumed sessions) is preserved untouched;
 *  - allToolsActive: activate every extra tool upfront.
 */
export function applyInitialActiveTools(pi: ExtensionAPI, allActive: boolean): void {
	if (!allActive) return;
	const active = pi.getActiveTools();
	const missing = EXTRA_TOOLS.filter((name) => !active.includes(name));
	if (missing.length > 0) {
		pi.setActiveTools([...active, ...missing]);
	}
}
