/**
 * Compact TUI rendering for terminal_* tool calls (pi ≥ 1.0.1).
 *
 * pi.registerToolRenderer() resolves renderers by tool NAME, before and
 * independently of tool registration, so these renderers also cover:
 *  - calls to deferred tools that are not activated (their default state);
 *  - terminal_* calls in resumed sessions and HTML exports, which render
 *    compactly even when the tool behind them is not registered at all.
 *
 * Renderers are pure display: no imports from runtime/core, so they keep
 * working even when the native node-pty chain failed to load and the tools
 * themselves are absent. The resolver passes unknown tool names through to
 * `next()`, and never touches `bash` — the PTY-backed bash override keeps
 * pi's native shell rendering.
 *
 * The types below mirror pi 1.0.1's ToolRendererResolver surface. On older
 * pi (0.99.x) the method does not exist and registerTerminalRenderers() is
 * a no-op, so the package stays installable against peerDeps >= 0.99.2.
 */

import type { AgentToolResult, ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";

// --- pi ≥ 1.0.1 renderer surface (mirrors core/extensions/types.ts) ---

export interface ToolRenderResultOptions {
	/** Whether the result view is expanded */
	expanded: boolean;
	/** Whether this is a partial/streaming result */
	isPartial: boolean;
}

export interface ToolRenderContext {
	args: unknown;
	toolCallId: string;
	invalidate: () => void;
	lastComponent: Component | undefined;
	state: Record<string, unknown>;
	cwd: string;
	executionStarted: boolean;
	argsComplete: boolean;
	isPartial: boolean;
	expanded: boolean;
	showImages: boolean;
	isError: boolean;
}

export interface ToolRenderers {
	renderShell?: "default" | "self";
	renderCall?: (args: unknown, theme: Theme, context: ToolRenderContext) => Component;
	renderResult?: (
		result: AgentToolResult,
		options: ToolRenderResultOptions,
		theme: Theme,
		context: ToolRenderContext,
	) => Component;
}

export type ToolRendererResolver = (
	toolName: string,
	next: () => ToolRenderers | undefined,
) => ToolRenderers | undefined;

type RendererCapableAPI = ExtensionAPI & {
	registerToolRenderer?: (resolver: ToolRendererResolver) => void;
};

// --- arg/payload accessors (args stream in incomplete; payloads are ours) ---

type Args = Record<string, unknown>;

function argsOf(context: ToolRenderContext): Args {
	return (context.args && typeof context.args === "object" ? context.args : {}) as Args;
}

function str(value: unknown): string | null {
	if (typeof value === "string") return value;
	if (value == null) return "";
	return null;
}

function num(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** structuredContent when present, else the JSON text block (resumed/HTML results). */
function payloadOf(result: AgentToolResult): Args | undefined {
	const structured = result.structuredContent;
	if (structured && typeof structured === "object" && !Array.isArray(structured)) {
		return structured as Args;
	}
	for (const block of result.content) {
		if (block.type !== "text") continue;
		try {
			const parsed: unknown = JSON.parse(block.text);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Args;
		} catch {
			// thrown-error results are plain text — handled by rawTextOf
		}
	}
	return undefined;
}

function rawTextOf(result: AgentToolResult): string {
	return result.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("\n")
		.trim();
}

// --- formatting helpers ---

const PREVIEW_LINES = 4;

function oneLine(text: string, max = 120): string {
	const flat = text.replace(/\s*\r?\n\s*/g, " ⏎ ");
	return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}

function pathTail(cwd: string | null | undefined, maxSegments = 2, maxLen = 32): string {
	if (!cwd) return "";
	const normalized = cwd.replace(/[\\/]+/g, "/").replace(/\/$/, "");
	const segments = normalized.split("/").filter(Boolean);
	const tail = segments.slice(-maxSegments).join("/");
	return tail.length <= maxLen ? tail : "…" + tail.slice(-(maxLen - 1));
}

function sessionTag(sessionId: string): string {
	if (!sessionId) return "";
	return sessionId.length > 12 ? "…" + sessionId.slice(-8) : sessionId;
}

function fmtBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fmtDuration(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)}ms`;
	const seconds = ms / 1000;
	if (seconds < 60) return `${seconds.toFixed(1)}s`;
	const totalSeconds = Math.floor(seconds);
	return `${Math.floor(totalSeconds / 60)}m ${totalSeconds % 60}s`;
}

/** Call line in pi's toolTitle style: bold `label subject`, muted suffix. */
function callLine(theme: Theme, label: string, subject: string | null, suffix = ""): string {
	const shown = subject === null ? theme.fg("error", "[invalid arg]") : subject === "" ? "..." : subject;
	let line = theme.fg("toolTitle", theme.bold(`${label} ${shown}`));
	if (suffix) line += theme.fg("muted", ` ${suffix}`);
	return line;
}

/** pi convention: reuse the slot's previous component instead of replacing it. */
function reuseText(context: ToolRenderContext): Text {
	if (context.lastComponent instanceof Text) return context.lastComponent;
	return new Text("", 0, 0);
}

function reuseContainer(context: ToolRenderContext): Container {
	if (context.lastComponent instanceof Container) return context.lastComponent;
	return new Container();
}

interface OutputPreview {
	lines: string[];
	hidden: number;
}

function tailPreview(text: string, expanded: boolean): OutputPreview {
	const all = text.replace(/\r/g, "").split("\n");
	while (all.length > 0 && all[all.length - 1] === "") all.pop();
	if (expanded || all.length <= PREVIEW_LINES) return { lines: all, hidden: 0 };
	return { lines: all.slice(-PREVIEW_LINES), hidden: all.length - PREVIEW_LINES };
}

/** Styled output block: toolOutput lines, muted hidden-count hint. */
function styledPreview(theme: Theme, text: string, expanded: boolean): string {
	const { lines, hidden } = tailPreview(text, expanded);
	const parts = lines.map((line) => theme.fg("toolOutput", line));
	if (hidden > 0) parts.push(theme.fg("muted", `... (${hidden} earlier lines)`));
	return parts.join("\n");
}

function badgeLine(
	theme: Theme,
	kind: "ok" | "fail" | "warn" | "info",
	text: string,
): string {
	const color = kind === "ok" ? "success" : kind === "fail" ? "error" : kind === "warn" ? "warning" : "muted";
	const glyph = kind === "ok" ? "✓" : kind === "fail" ? "✗" : kind === "warn" ? "⏱" : "·";
	return theme.fg(color, `${glyph} ${text}`);
}

// --- shared renderer shapes ---

function renderCallWith(format: (args: Args, theme: Theme) => string): NonNullable<ToolRenderers["renderCall"]> {
	return (args, theme, context) => {
		const text = reuseText(context);
		text.setText(format(argsOf(context), theme));
		return text;
	};
}

interface ResultSection {
	/** Leading status line (badge/meta). */
	badge?: string;
	/** Body: output preview, already styled. */
	body?: string;
	/** Trailing muted line(s). */
	footer?: string;
}

function renderResultWith(build: (result: AgentToolResult, options: ToolRenderResultOptions, theme: Theme) => ResultSection): NonNullable<ToolRenderers["renderResult"]> {
	return (result, options, theme, context) => {
		const section = build(result, options, theme);
		const container = reuseContainer(context);
		container.clear();
		const text = [section.badge, section.body, section.footer].filter(Boolean).join("\n");
		if (text) container.addChild(new Text(text, 0, 0));
		container.invalidate();
		return container;
	};
}

/** Shell-command tools (terminal_exec / terminal_retry): command + exit badge + output preview. */
function sessionCommandRenderers(label: string, withAttempts: boolean): ToolRenderers {
	return {
		renderCall: renderCallWith((args, theme) => {
			const command = str(args.command);
			return callLine(
				theme,
				label,
				// null (non-string arg) must stay null so callLine marks it invalid
				command === null ? null : oneLine(command),
				sessionTag(str(args.sessionId) ?? ""),
			);
		}),
		renderResult: renderResultWith((result, options, theme) => {
			const payload = payloadOf(result);
			if (!payload) return { badge: contextErrorBadge(theme, result) };

			const exitCode = num(payload.exitCode);
			const timedOut = payload.timedOut === true;
			const quiet = payload.quietExited === true;
			const attempts = num(payload.attempts);

			const badgeParts: string[] = [];
			if (timedOut) badgeParts.push(badgeLine(theme, "warn", "timed out"));
			else if (exitCode === undefined) badgeParts.push(badgeLine(theme, "warn", "no exit code"));
			else if (exitCode === 0) badgeParts.push(badgeLine(theme, "ok", "exit 0"));
			else badgeParts.push(badgeLine(theme, "fail", `exit ${exitCode}`));
			if (quiet) badgeParts.push(theme.fg("muted", "quiet-exit"));
			if (withAttempts && attempts !== undefined) badgeParts.push(theme.fg("muted", `${attempts} attempt${attempts === 1 ? "" : "s"}`));
			const cwd = pathTail(str(payload.cwd));
			if (cwd) badgeParts.push(theme.fg("muted", cwd));

			return { badge: badgeParts.join(theme.fg("muted", " · ")), body: styledPreview(theme, str(payload.output) ?? "", options.expanded) };
		}),
	};
}

/** One-shot binary tools (terminal_run / terminal_run_paged): exit, duration, stdout preview. */
function runCommandRenderers(label: string, withPaging: boolean): ToolRenderers {
	return {
		renderCall: renderCallWith((args, theme) => {
			const cmd = [str(args.cmd) ?? "", ...(Array.isArray(args.args) ? (args.args as unknown[]) : [])]
				.map((part) => oneLine(String(part), 40))
				.filter(Boolean)
				.join(" ");
			return callLine(theme, label, cmd || null);
		}),
		renderResult: renderResultWith((result, options, theme) => {
			const payload = payloadOf(result);
			if (!payload) return { badge: contextErrorBadge(theme, result) };

			const exitCode = num(payload.exitCode);
			const durationMs = num(payload.durationMs);
			const timedOut = payload.timedOut === true;

			const badgeParts: string[] = [];
			if (timedOut) badgeParts.push(badgeLine(theme, "warn", "timed out"));
			else if (exitCode === 0) badgeParts.push(badgeLine(theme, "ok", "exit 0"));
			else if (exitCode !== undefined) badgeParts.push(badgeLine(theme, "fail", `exit ${exitCode}`));
			if (durationMs !== undefined) badgeParts.push(theme.fg("muted", fmtDuration(durationMs)));

			const stdout = payload.stdout as { raw?: unknown } | undefined;
			const stderr = payload.stderr as { raw?: unknown } | undefined;
			let output = str(stdout?.raw) ?? "";
			const errText = (str(stderr?.raw) ?? "").trim();
			if (errText) output = output ? `${output}\n${theme.fg("error", errText)}` : theme.fg("error", errText);

			const footerParts: string[] = [];
			if (withPaging) {
				const pageInfo = payload.pageInfo as Record<string, unknown> | undefined;
				if (pageInfo) {
					const page = num(pageInfo.page);
					const totalLines = num(pageInfo.totalLines);
					const hasNext = pageInfo.hasNext === true;
					footerParts.push(theme.fg("muted", `page ${page ?? 0} of ${totalLines ?? "?"} lines${hasNext ? ", more →" : ""}`));
				}
			}
			const summary = str(payload.summary);
			if (summary) footerParts.push(theme.fg("muted", oneLine(summary, 100)));
			const footer = footerParts.length > 0 ? footerParts.join("\n") : undefined;

			return { badge: badgeParts.join(theme.fg("muted", " · ")), body: styledPreview(theme, output, options.expanded), footer };
		}),
	};
}

/** Error results from thrown execute() errors: plain text, no JSON payload. */
function contextErrorBadge(theme: Theme, result: AgentToolResult): string {
	const text = rawTextOf(result);
	if (!text) return badgeLine(theme, "fail", "failed");
	return `${badgeLine(theme, "fail", "failed")}\n${theme.fg("error", oneLine(text, 200))}`;
}

// --- per-tool renderers ---

const TERMINAL_RENDERERS: Record<string, ToolRenderers> = {
	terminal_exec: sessionCommandRenderers("terminal_exec", false),
	terminal_retry: sessionCommandRenderers("terminal_retry", true),
	terminal_run: runCommandRenderers("terminal_run", false),
	terminal_run_paged: runCommandRenderers("terminal_run_paged", true),

	terminal_read: {
		renderCall: renderCallWith((args, theme) => {
			const since = num(args.since);
			return callLine(
				theme,
				"terminal_read",
				sessionTag(str(args.sessionId) ?? ""),
				since !== undefined ? `since ${since}` : "",
			);
		}),
		renderResult: renderResultWith((result, options, theme) => {
			const payload = payloadOf(result);
			if (!payload) return { badge: contextErrorBadge(theme, result) };
			const output = str(payload.output) ?? "";
			const position = num(payload.position);
			const lineCount = output.trim() ? output.trim().split("\n").length : 0;
			const badgeParts = [
				badgeLine(theme, lineCount > 0 ? "ok" : "info", lineCount > 0 ? `+${lineCount} line${lineCount === 1 ? "" : "s"}` : "no new output"),
			];
			if (position !== undefined) badgeParts.push(theme.fg("muted", `at ${position}`));
			if (payload.truncated === true) badgeParts.push(theme.fg("warning", "truncated"));
			return { badge: badgeParts.join(theme.fg("muted", " · ")), body: styledPreview(theme, output, options.expanded) };
		}),
	},

	terminal_write: {
		renderCall: renderCallWith((args, theme) =>
			callLine(theme, "terminal_write", JSON.stringify(oneLine(str(args.data) ?? "")), sessionTag(str(args.sessionId) ?? "")),
		),
		renderResult: renderResultWith((_result, _options, theme) => ({
			badge: badgeLine(theme, "ok", "written"),
		})),
	},

	terminal_send_key: {
		renderCall: renderCallWith((args, theme) =>
			callLine(theme, "terminal_send_key", str(args.key), sessionTag(str(args.sessionId) ?? "")),
		),
		renderResult: renderResultWith((_result, _options, theme) => ({
			badge: badgeLine(theme, "ok", "sent"),
		})),
	},

	terminal_resize: {
		renderCall: renderCallWith((args, theme) => {
			const cols = num(args.cols);
			const rows = num(args.rows);
			return callLine(theme, "terminal_resize", cols !== undefined && rows !== undefined ? `${cols}×${rows}` : null, sessionTag(str(args.sessionId) ?? ""));
		}),
		renderResult: renderResultWith((_result, _options, theme) => ({
			badge: badgeLine(theme, "ok", "resized"),
		})),
	},

	terminal_wait: {
		renderCall: renderCallWith((args, theme) =>
			callLine(theme, "terminal_wait", JSON.stringify(oneLine(str(args.pattern) ?? "", 60)), sessionTag(str(args.sessionId) ?? "")),
		),
		renderResult: renderResultWith((result, options, theme) => {
			const payload = payloadOf(result);
			if (!payload) return { badge: contextErrorBadge(theme, result) };
			const matched = payload.matched === true;
			const badge = matched
				? badgeLine(theme, "ok", "matched")
				: badgeLine(theme, "fail", payload.timedOut === true ? "no match (timeout)" : "no match");
			return { badge, body: styledPreview(theme, str(payload.output) ?? "", options.expanded) };
		}),
	},

	terminal_watch: {
		renderCall: renderCallWith((args, theme) => {
			const triggers = Array.isArray(args.triggers)
				? (args.triggers as Args[]).map((t) => str(t?.id) || str(t?.pattern) || "?").filter(Boolean)
				: [];
			return callLine(theme, "terminal_watch", triggers.join(", ") || null, sessionTag(str(args.sessionId) ?? ""));
		}),
		renderResult: renderResultWith((result, options, theme) => {
			const payload = payloadOf(result);
			if (!payload) return { badge: contextErrorBadge(theme, result) };
			const reason = str(payload.reason);
			const triggerId = str(payload.triggerId);
			const matchedLine = str(payload.matchedLine);
			let badge: string;
			switch (reason) {
				case "trigger":
					badge = badgeLine(theme, "ok", `trigger ${triggerId ?? "?"}${matchedLine ? `: ${oneLine(matchedLine, 80)}` : ""}`);
					break;
				case "quiet":
					badge = badgeLine(theme, "info", "output went quiet");
					break;
				case "exit":
					badge = badgeLine(theme, "info", "session exited");
					break;
				default:
					badge = badgeLine(theme, "fail", "timeout — no trigger matched");
					break;
			}
			const context = Array.isArray(payload.context) ? (payload.context as unknown[]).map(String) : [];
			return { badge, body: styledPreview(theme, context.join("\n"), options.expanded) };
		}),
	},

	terminal_start: {
		renderCall: renderCallWith((args, theme) => {
			const name = str(args.name);
			const shell = str(args.shell);
			const suffix = [name, shell].filter(Boolean).join(" · ");
			return callLine(theme, "terminal_start", name ? JSON.stringify(name) : "", suffix);
		}),
		renderResult: renderResultWith((result, options, theme) => {
			const payload = payloadOf(result);
			if (!payload) return { badge: contextErrorBadge(theme, result) };
			const parts = [
				badgeLine(theme, "ok", sessionTag(str(payload.sessionId) ?? "")),
				theme.fg("muted", [str(payload.shellType), str(payload.cwd) ? pathTail(str(payload.cwd)) : ""].filter(Boolean).join(" @ ")),
			].filter(Boolean);
			const banner = str(payload.banner) ?? "";
			return { badge: parts.join(theme.fg("muted", " · ")), body: styledPreview(theme, banner, options.expanded) };
		}),
	},

	terminal_stop: {
		renderCall: renderCallWith((args, theme) => {
			const extras = [num(args.snapshotLines) ? "snapshot" : "", str(args.transcriptPath) ? "transcript" : ""].filter(Boolean);
			return callLine(theme, "terminal_stop", sessionTag(str(args.sessionId) ?? ""), extras.join(", "));
		}),
		renderResult: renderResultWith((result, options, theme) => {
			const payload = payloadOf(result);
			if (!payload) return { badge: contextErrorBadge(theme, result) };
			const snapshot = payload.snapshot as { text?: unknown } | undefined;
			const transcript = payload.transcript as { path?: unknown; bytes?: unknown } | undefined;
			let footer: string | undefined;
			if (transcript) {
				const bytes = num(transcript.bytes);
				footer = theme.fg("muted", `transcript ${fmtBytes(bytes ?? 0)} → ${str(transcript.path) ?? "?"}`);
			}
			return {
				badge: badgeLine(theme, "ok", str(payload.message) || "stopped"),
				body: snapshot ? styledPreview(theme, str(snapshot.text) ?? "", options.expanded) : undefined,
				footer,
			};
		}),
	},

	terminal_list: {
		renderCall: renderCallWith((_args, theme) => callLine(theme, "terminal_list", "")),
		renderResult: renderResultWith((result, _options, theme) => {
			const payload = payloadOf(result);
			if (!payload) return { badge: contextErrorBadge(theme, result) };
			const sessions = Array.isArray(payload.sessions) ? (payload.sessions as Args[]) : [];
			const count = num(payload.count) ?? sessions.length;
			if (count === 0) return { badge: badgeLine(theme, "info", "no sessions") };
			const shown = sessions.slice(0, 6);
			const lines = shown.map((s) => {
				const busy = s.busy === true;
				const alive = s.alive !== false;
				const glyph = !alive ? "✝" : busy ? "⏵" : "◇";
				const name = str(s.name);
				return theme.fg(
					"toolOutput",
					`${glyph} ${sessionTag(str(s.id) ?? "")}${name ? ` (${name})` : ""} ${pathTail(str(s.cwd))}`,
				);
			});
			const hidden = count - shown.length;
			if (hidden > 0) lines.push(theme.fg("muted", `... +${hidden} more`));
			return { badge: badgeLine(theme, "info", `${count} session${count === 1 ? "" : "s"}`), body: lines.join("\n") };
		}),
	},

	terminal_diff: {
		renderCall: renderCallWith((args, theme) => {
			const a = oneLine(str(args.commandA) ?? "", 40);
			const b = oneLine(str(args.commandB) ?? "", 40);
			return callLine(theme, "terminal_diff", a && b ? `${a} ↔ ${b}` : null, sessionTag(str(args.sessionId) ?? ""));
		}),
		renderResult: renderResultWith((result, options, theme) => {
			const payload = payloadOf(result);
			if (!payload) return { badge: contextErrorBadge(theme, result) };
			const stats = payload.stats as { added?: unknown; removed?: unknown } | undefined;
			const added = num(stats?.added) ?? 0;
			const removed = num(stats?.removed) ?? 0;
			const changed = payload.changed === true;
			const badge = changed
				? `${badgeLine(theme, "info", "changed")} ${theme.fg("success", `+${added}`)} ${theme.fg("error", `−${removed}`)}`
				: badgeLine(theme, "ok", "unchanged");
			const diff = str(payload.diff) ?? "";
			const body = diff
				? tailPreview(diff, options.expanded).lines
						.map((line) => {
							const color = line.startsWith("+") ? "toolDiffAdded" : line.startsWith("-") ? "toolDiffRemoved" : "toolDiffContext";
							return theme.fg(color, line);
						})
						.join("\n")
				: undefined;
			return { badge, body };
		}),
	},

	terminal_get_history: {
		renderCall: renderCallWith((args, theme) => {
			const offset = num(args.offset);
			return callLine(theme, "terminal_get_history", sessionTag(str(args.sessionId) ?? ""), offset ? `last ${offset}` : "");
		}),
		renderResult: renderResultWith((result, options, theme) => {
			const payload = payloadOf(result);
			if (!payload) return { badge: contextErrorBadge(theme, result) };
			const from = num(payload.returnedFrom);
			const to = num(payload.returnedTo);
			const total = num(payload.totalLines);
			const range = from !== undefined && to !== undefined ? `${from}–${to}` : "?";
			const text = Array.isArray(payload.lines)
				? (payload.lines as unknown[]).map(String).join("\n")
				: str(payload.text) ?? "";
			return {
				badge: badgeLine(theme, "info", `lines ${range} of ${total ?? "?"}`),
				body: styledPreview(theme, text, options.expanded),
			};
		}),
	},

	terminal_write_file: {
		renderCall: renderCallWith((args, theme) =>
			callLine(theme, "terminal_write_file", str(args.path) || null, [
				args.append === true ? "append" : "",
				sessionTag(str(args.sessionId) ?? ""),
			].filter(Boolean).join(" ")),
		),
		renderResult: renderResultWith((result, _options, theme) => {
			const payload = payloadOf(result);
			if (!payload) return { badge: contextErrorBadge(theme, result) };
			const size = num(payload.size);
			return {
				badge: `${badgeLine(theme, "ok", size !== undefined ? fmtBytes(size) : "written")} ${theme.fg("muted", `→ ${str(payload.path) ?? "?"}`)}`,
			};
		}),
	},

	terminal_tools: {
		renderCall: renderCallWith((args, theme) => {
			const names = Array.isArray(args.names) ? (args.names as unknown[]).map(String).join(", ") : "";
			return callLine(theme, "terminal_tools", oneLine(names) || null, args.list === true ? "list" : "");
		}),
		renderResult: renderResultWith((result, _options, theme) => {
			const payload = payloadOf(result);
			if (!payload) return { badge: contextErrorBadge(theme, result) };
			const tools = Array.isArray(payload.tools) ? (payload.tools as Args[]) : undefined;
			if (tools) {
				const names = tools.map((t) => str(t.name)).filter((n): n is string => Boolean(n));
				return {
					badge: badgeLine(theme, "info", `${names.length} loadable tools`),
					body: names.map((name) => theme.fg("toolOutput", name)).join("\n"),
				};
			}
			const activated = Array.isArray(payload.activated) ? (payload.activated as unknown[]).map(String) : [];
			const already = Array.isArray(payload.alreadyActive) ? (payload.alreadyActive as unknown[]).map(String) : [];
			const parts = [
				activated.length > 0 ? badgeLine(theme, "ok", `activated: ${activated.join(", ")}`) : undefined,
				already.length > 0 ? badgeLine(theme, "info", `already active: ${already.join(", ")}`) : undefined,
			].filter(Boolean);
			return { badge: parts.join("\n") || badgeLine(theme, "info", "nothing to activate") };
		}),
	},
};

/** Register the resolver; returns false on pi < 1.0.1 (no registerToolRenderer). */
export function registerTerminalRenderers(pi: ExtensionAPI): boolean {
	const capable = pi as RendererCapableAPI;
	if (typeof capable.registerToolRenderer !== "function") return false;
	capable.registerToolRenderer((toolName, next) => TERMINAL_RENDERERS[toolName] ?? next());
	return true;
}

/** Exposed for tests: the renderer map the resolver serves. */
export function terminalRenderersFor(toolName: string): ToolRenderers | undefined {
	return TERMINAL_RENDERERS[toolName];
}
