import { describe, expect, it } from "vitest";

import type { AgentToolResult, Theme } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";

import {
	registerTerminalRenderers,
	terminalRenderersFor,
	type ToolRenderContext,
	type ToolRenderers,
	type ToolRendererResolver,
} from "../src/renderers.js";
import { ALL_TOOL_NAMES } from "../src/tools.js";

// Markers instead of ANSI so substring assertions survive Text.render().
const theme = {
	fg: (color: string, text: string) => `[c:${color}]${text}[/c:${color}]`,
	bold: (text: string) => `[b]${text}[/b]`,
} as unknown as Theme;

function ctx(overrides: Partial<ToolRenderContext> = {}): ToolRenderContext {
	return {
		args: {},
		toolCallId: "call-1",
		invalidate: () => {},
		lastComponent: undefined,
		state: {},
		cwd: "/repo",
		executionStarted: false,
		argsComplete: true,
		isPartial: false,
		expanded: false,
		showImages: false,
		isError: false,
		...overrides,
	};
}

function payloadResult(payload: unknown, isError = false, withStructured = true): AgentToolResult {
	const result: AgentToolResult = {
		content: [{ type: "text", text: JSON.stringify(payload) }],
		details: {},
	};
	if (withStructured) result.structuredContent = payload as never;
	if (isError) result.isError = true;
	return result;
}

/** Thrown-error results: plain text, no JSON payload. */
function errorResult(message: string): AgentToolResult {
	return { content: [{ type: "text", text: message }], details: {}, isError: true };
}

function rendered(component: { render: (width: number) => string[] }): string {
	return component.render(300).join("\n");
}

function callOf(toolName: string, args: unknown, context?: Partial<ToolRenderContext>): string {
	const renderers = terminalRenderersFor(toolName);
	if (!renderers?.renderCall) throw new Error(`no renderCall for ${toolName}`);
	return rendered(renderers.renderCall(args, theme, ctx({ ...context, args })));
}

function resultOf(
	toolName: string,
	result: AgentToolResult,
	options: { expanded?: boolean } = {},
): string {
	const renderers = terminalRenderersFor(toolName);
	if (!renderers?.renderResult) throw new Error(`no renderResult for ${toolName}`);
	return rendered(
		renderers.renderResult(result, { expanded: options.expanded ?? false, isPartial: false }, theme, ctx()),
	);
}

describe("registerTerminalRenderers (pi ≥ 1.0.1 resolver)", () => {
	it("is a no-op returning false on pi without registerToolRenderer (0.99.x)", () => {
		expect(registerTerminalRenderers({} as never)).toBe(false);
	});

	it("registers a resolver that serves renderers for every terminal tool", () => {
		let resolver: ToolRendererResolver | undefined;
		const pi = {
			registerToolRenderer: (r: ToolRendererResolver) => {
				resolver = r;
			},
		};
		expect(registerTerminalRenderers(pi as never)).toBe(true);
		expect(resolver).toBeDefined();

		for (const name of [...ALL_TOOL_NAMES, "terminal_tools"]) {
			const renderers = resolver!(name, () => undefined);
			expect(renderers, name).toBeDefined();
			expect(renderers!.renderCall, name).toBeTypeOf("function");
			expect(renderers!.renderResult, name).toBeTypeOf("function");
		}
	});

	it("passes non-terminal tools through to next()", () => {
		let resolver: ToolRendererResolver | undefined;
		registerTerminalRenderers({
			registerToolRenderer: (r: ToolRendererResolver) => {
				resolver = r;
			},
		} as never);
		const bashRenderers = { renderShell: "default" } as ToolRenderers;
		for (const name of ["bash", "read", "edit", "mcp__server__tool"]) {
			expect(resolver!(name, () => bashRenderers), name).toBe(bashRenderers);
		}
	});
});

describe("terminal_exec / terminal_retry rendering", () => {
	it("renders the call as a one-line command with the session tag", () => {
		const line = callOf("terminal_exec", { sessionId: "s1", command: "npm test" });
		expect(line).toContain("terminal_exec");
		expect(line).toContain("npm test");
		expect(line).toContain("s1");
	});

	it("collapses multi-line commands", () => {
		const line = callOf("terminal_exec", { sessionId: "s1", command: "echo a\necho b" });
		expect(line.split("\n")).toHaveLength(1);
		expect(line).toContain("⏎");
	});

	it("marks non-string args as invalid", () => {
		expect(callOf("terminal_exec", { command: 42 })).toContain("[invalid arg]");
	});

	it("badges exit 0 and shows a collapsed tail preview", () => {
		const output = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n");
		const text = resultOf("terminal_exec", payloadResult({ output, exitCode: 0, cwd: "/repo/packages/api", timedOut: false }));
		expect(text).toContain("exit 0");
		expect(text).toContain("packages/api");
		expect(text).toContain("line 10");
		expect(text).toContain("(6 earlier lines)");
		expect(text).not.toContain("line 1\n");
	});

	it("shows the full output when expanded", () => {
		const output = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n");
		const text = resultOf("terminal_exec", payloadResult({ output, exitCode: 0, cwd: null, timedOut: false }), { expanded: true });
		expect(text).toContain("line 1");
		expect(text).not.toContain("earlier lines");
	});

	it("badges non-zero exits, timeouts and retry attempts", () => {
		expect(resultOf("terminal_exec", payloadResult({ output: "err", exitCode: 2, cwd: null, timedOut: false }))).toContain("exit 2");
		expect(resultOf("terminal_exec", payloadResult({ output: "", exitCode: null, cwd: null, timedOut: true }))).toContain("timed out");
		expect(
			resultOf("terminal_retry", payloadResult({ output: "", exitCode: 0, cwd: null, timedOut: false, attempts: 3, retryLog: [] })),
		).toContain("3 attempts");
	});

	it("falls back to parsing the JSON text block when structuredContent is absent (resumed/HTML results)", () => {
		const text = resultOf("terminal_exec", payloadResult({ output: "ok", exitCode: 0, cwd: null, timedOut: false }, false, false));
		expect(text).toContain("exit 0");
		expect(text).toContain("ok");
	});

	it("renders thrown errors as a failure badge with the message", () => {
		const text = resultOf("terminal_exec", errorResult("Session not found: s9"));
		expect(text).toContain("failed");
		expect(text).toContain("Session not found: s9");
	});
});

describe("terminal_run / terminal_run_paged rendering", () => {
	it("renders cmd + args in the call line", () => {
		const line = callOf("terminal_run", { cmd: "git", args: ["status", "--short"] });
		expect(line).toContain("terminal_run");
		expect(line).toContain("git status --short");
	});

	it("badges exit code and duration, previews stdout and stderr", () => {
		const payload = {
			cmd: "npm",
			args: ["test"],
			exitCode: 1,
			timedOut: false,
			killed: false,
			durationMs: 1540,
			stdout: { raw: "3 passed", parsed: null },
			stderr: { raw: "1 failed", parsed: null },
		};
		const text = resultOf("terminal_run", payloadResult(payload, true));
		expect(text).toContain("exit 1");
		expect(text).toContain("1.5s");
		expect(text).toContain("3 passed");
		expect(text).toContain("1 failed");
	});

	it("shows page info and summary for terminal_run_paged", () => {
		const payload = {
			cmd: "git",
			args: ["log"],
			exitCode: 0,
			timedOut: false,
			killed: false,
			durationMs: 120,
			stdout: { raw: "commit 1\ncommit 2", parsed: null },
			stderr: { raw: "", parsed: null },
			summary: "12 commits",
			pageInfo: { page: 1, pageSize: 2, totalLines: 12, hasNext: true },
		};
		const text = resultOf("terminal_run_paged", payloadResult(payload));
		expect(text).toContain("page 1 of 12 lines");
		expect(text).toContain("more →");
		expect(text).toContain("12 commits");
	});
});

describe("observer tool rendering", () => {
	it("terminal_read: line count, position and truncation marker", () => {
		const text = resultOf(
			"terminal_read",
			payloadResult({ output: "a\nb\nc", timedOut: false, position: 8192, truncated: true }),
		);
		expect(text).toContain("+3 lines");
		expect(text).toContain("at 8192");
		expect(text).toContain("truncated");
	});

	it("terminal_read: silent result", () => {
		expect(resultOf("terminal_read", payloadResult({ output: "", timedOut: true, position: 100 }))).toContain("no new output");
	});

	it("terminal_wait: matched vs no-match badges", () => {
		expect(resultOf("terminal_wait", payloadResult({ output: "listening on 3000", matched: true, timedOut: false }))).toContain("matched");
		expect(resultOf("terminal_wait", payloadResult({ output: "", matched: false, timedOut: true }, true))).toContain("no match (timeout)");
	});

	it("terminal_watch: trigger reason with matched line, and timeout", () => {
		const trigger = resultOf(
			"terminal_watch",
			payloadResult({ reason: "trigger", triggerId: "error", matchedLine: "Error: EADDRINUSE", position: 5, timedOut: false }),
		);
		expect(trigger).toContain("trigger error");
		expect(trigger).toContain("EADDRINUSE");
		expect(resultOf("terminal_watch", payloadResult({ reason: "timeout", position: 9, timedOut: true }, true))).toContain("timeout");
	});

	it("terminal_get_history: line range and preview", () => {
		const text = resultOf(
			"terminal_get_history",
			payloadResult({ sessionId: "s1", lines: ["one", "two"], totalLines: 120, returnedFrom: 10, returnedTo: 12 }),
		);
		expect(text).toContain("lines 10–12 of 120");
		expect(text).toContain("two");
	});

	it("terminal_list: session count, ids and busy/alive glyphs", () => {
		const payload = {
			sessions: [
				{ id: "s1", name: null, cwd: "/repo/packages/api", alive: true, busy: true },
				{ id: "s2", name: "dev", cwd: "/repo", alive: false, busy: false },
			],
			count: 2,
		};
		const text = resultOf("terminal_list", payloadResult(payload));
		expect(text).toContain("2 sessions");
		expect(text).toContain("⏵ s1");
		expect(text).toContain("✝ s2 (dev)");
		expect(resultOf("terminal_list", payloadResult({ sessions: [], count: 0 }))).toContain("no sessions");
	});
});

describe("lifecycle / mutation tool rendering", () => {
	it("terminal_start: id, shell type and cwd tail", () => {
		const text = resultOf(
			"terminal_start",
			payloadResult({ sessionId: "s1", shell: "/bin/zsh", shellType: "zsh", cwd: "/repo/packages/api", banner: "%" }),
		);
		expect(text).toContain("s1");
		expect(text).toContain("zsh");
		expect(text).toContain("packages/api");
	});

	it("terminal_stop: message plus transcript footer", () => {
		const text = resultOf(
			"terminal_stop",
			payloadResult({
				success: true,
				message: "Session s1 stopped.",
				transcript: { path: "/tmp/out.log", bytes: 2048 },
			}),
		);
		expect(text).toContain("stopped");
		expect(text).toContain("transcript");
		expect(text).toContain("/tmp/out.log");
		expect(text).toContain("2.0 KB");
	});

	it("terminal_write / terminal_send_key / terminal_resize: compact confirmations", () => {
		expect(resultOf("terminal_write", payloadResult({ success: true, sessionId: "s1" }))).toContain("written");
		expect(resultOf("terminal_send_key", payloadResult({ success: true, key: "enter" }))).toContain("sent");
		expect(resultOf("terminal_resize", payloadResult({ success: true, cols: 120, rows: 30 }))).toContain("resized");
		expect(callOf("terminal_resize", { sessionId: "s1", cols: 120, rows: 30 })).toContain("120×30");
	});

	it("terminal_write_file: size and destination path", () => {
		const text = resultOf("terminal_write_file", payloadResult({ success: true, path: "/repo/out.txt", size: 512, append: false }));
		expect(text).toContain("512 B");
		expect(text).toContain("/repo/out.txt");
	});

	it("terminal_diff: changed stats and colored diff body", () => {
		const text = resultOf(
			"terminal_diff",
			payloadResult({
				commandA: "git branch --show-current",
				commandB: "echo main",
				diff: "+ main\n- feature/x",
				changed: true,
				stats: { added: 1, removed: 1 },
			}),
		);
		expect(text).toContain("changed");
		expect(text).toContain("+1");
		expect(text).toContain("−1");
		expect(text).toContain("[c:toolDiffAdded]+ main");
		expect(text).toContain("[c:toolDiffRemoved]- feature/x");
	});

	it("terminal_tools: activation report and catalog listing", () => {
		const activated = resultOf("terminal_tools", payloadResult({ activated: ["terminal_watch"], alreadyActive: ["terminal_diff"] }));
		expect(activated).toContain("activated: terminal_watch");
		expect(activated).toContain("already active: terminal_diff");
		const catalog = resultOf(
			"terminal_tools",
			payloadResult({ tools: [{ name: "terminal_watch", description: "watch" }, { name: "terminal_diff", description: "diff" }] }),
		);
		expect(catalog).toContain("2 loadable tools");
		expect(catalog).toContain("terminal_watch");
	});
});

describe("pi component conventions", () => {
	it("reuses the call slot's Text and the result slot's Container", () => {
		const callText = new Text("old", 0, 0);
		const returnedCall = terminalRenderersFor("terminal_read")!.renderCall!({ sessionId: "s1" }, theme, ctx({ lastComponent: callText }));
		expect(returnedCall).toBe(callText);

		const resultBox = new Container();
		const returnedResult = terminalRenderersFor("terminal_read")!.renderResult!(
			payloadResult({ output: "x", timedOut: false, position: 1 }),
			{ expanded: false, isPartial: false },
			theme,
			ctx({ lastComponent: resultBox }),
		);
		expect(returnedResult).toBe(resultBox);
	});

	it("tolerates missing/partial streamed args", () => {
		for (const name of [...ALL_TOOL_NAMES, "terminal_tools"]) {
			const renderers = terminalRenderersFor(name);
			expect(() => renderers!.renderCall!({}, theme, ctx({ argsComplete: false })), name).not.toThrow();
			expect(() => renderers!.renderCall!(undefined, theme, ctx({ argsComplete: false })), name).not.toThrow();
			expect(
				() => renderers!.renderResult!(payloadResult({}), { expanded: false, isPartial: true }, theme, ctx()),
				name,
			).not.toThrow();
		}
	});
});
