import { describe, expect, it } from "vitest";

import {
	CORE_TOOLS,
	EXTRA_TOOLS,
	TERMINAL_NAMESPACE,
	applyInitialActiveTools,
	registerTerminalTools,
} from "../src/tools.js";
import { runtime } from "../src/runtime.js";
import smartTerminalExtension from "../src/index.js";

interface RegisteredTool {
	name: string;
	exposure?: string;
	namespace?: { name: string };
	annotations?: Record<string, boolean | undefined>;
	outputSchema?: unknown;
	parameters?: unknown;
	execute: (id: string, params: unknown) => Promise<unknown>;
}

function fakePi() {
	const tools: RegisteredTool[] = [] as never as RegisteredTool[];
	const handlers = new Map<string, Array<(event: never, ctx: never) => Promise<unknown>>>();
	let active: string[] = [];
	const pi = {
		registerTool: (tool: RegisteredTool) => {
			tools.push(tool);
			if (!tool.exposure || tool.exposure === "direct" || tool.exposure === "model-only") {
				active = [...new Set([...active, tool.name])];
			}
		},
		registerCommand: () => {},
		on: (type: string, handler: (event: never, ctx: never) => Promise<unknown>) => {
			const list = handlers.get(type) ?? [];
			list.push(handler);
			handlers.set(type, list);
		},
		getAllTools: () => tools.map((t) => ({ name: t.name, description: t.name })),
		getActiveTools: () => [...active],
		setActiveTools: (names: string[]) => {
			active = [...names];
		},
		__tools: tools,
		__handlers: handlers,
		__active: () => active,
	};
	return pi;
}

describe("registerTerminalTools (pi ≥ 0.99 metadata)", () => {
	const pi = fakePi();
	registerTerminalTools(pi as never);
	const tools = pi.__tools;
	const byName = new Map(tools.map((t) => [t.name, t]));

	it("registers the full catalog (8 core + 8 extras + loader)", () => {
		expect(tools.map((t) => t.name).sort()).toEqual(
			[...CORE_TOOLS, ...EXTRA_TOOLS, "terminal_tools"].sort(),
		);
	});

	it("puts every tool in the smart-terminal namespace", () => {
		for (const tool of tools) {
			expect(tool.namespace?.name, tool.name).toBe(TERMINAL_NAMESPACE.name);
		}
		expect(TERMINAL_NAMESPACE.instructions?.length).toBeGreaterThan(50);
	});

	it("declares an outputSchema on every tool", () => {
		for (const tool of tools) {
			expect(tool.outputSchema, tool.name).toBeDefined();
		}
	});

	it("keeps core tools direct and extras deferred (codemode-callable, tool_search-findable)", () => {
		for (const name of CORE_TOOLS) {
			expect(byName.get(name)?.exposure ?? "direct", name).toBe("direct");
		}
		for (const name of EXTRA_TOOLS) {
			expect(byName.get(name)?.exposure, name).toBe("deferred");
		}
	});

	it("marks observers read-only and killers/writers destructive", () => {
		const readOnly = [
			"terminal_read",
			"terminal_list",
			"terminal_get_history",
			"terminal_wait",
			"terminal_watch",
			"terminal_run_paged",
		];
		for (const name of readOnly) {
			expect(byName.get(name)?.annotations?.readOnlyHint, name).toBe(true);
		}
		expect(byName.get("terminal_stop")?.annotations?.destructiveHint).toBe(true);
		expect(byName.get("terminal_write_file")?.annotations?.destructiveHint).toBe(true);
	});

	it("returns structuredContent alongside the JSON text content", async () => {
		const loader = byName.get("terminal_tools")!;
		const result = (await loader.execute("t1", { list: true })) as {
			content: Array<{ type: string; text: string }>;
			structuredContent: { tools: Array<{ name: string }> };
		};
		expect(result.content[0]?.type).toBe("text");
		expect(JSON.parse(result.content[0].text).tools).toHaveLength(EXTRA_TOOLS.length);
		expect(result.structuredContent.tools.map((t) => t.name)).toEqual([...EXTRA_TOOLS]);
	});
});

describe("applyInitialActiveTools (deferred extras)", () => {
	it("leaves the active set untouched by default (user pins survive)", () => {
		const pi = fakePi();
		registerTerminalTools(pi as never);
		pi.setActiveTools(["terminal_start", "terminal_watch"]); // user pin
		applyInitialActiveTools(pi as never, false);
		expect(pi.__active()).toEqual(["terminal_start", "terminal_watch"]);
	});

	it("activates every extra tool when allToolsActive is set", () => {
		const pi = fakePi();
		registerTerminalTools(pi as never);
		applyInitialActiveTools(pi as never, true);
		expect(pi.__active().sort()).toEqual([...CORE_TOOLS, "terminal_tools", ...EXTRA_TOOLS].sort());
	});
});

describe("context_with_system session-state injection", () => {
	it("appends a trailing terminal_sessions system message, leading prompt untouched", async () => {
		const pi = fakePi();
		smartTerminalExtension(pi as never);

		// session_start loads the module chain lazily; then stub the manager.
		const fakeUiCtx = { hasUI: false, ui: { setStatus: () => {}, notify: () => {} } };
		for (const handler of pi.__handlers.get("session_start") ?? []) {
			await handler({ cwd: process.cwd() } as never, fakeUiCtx as never);
		}
		runtime.manager = {
			list: () => [
				{
					id: "s_1",
					name: null,
					cwd: "C:/repo",
					alive: true,
					busy: false,
					shellType: "pwsh",
				},
			],
			destroyAll: () => {},
		} as never;

		try {
			const leading = { role: "system", content: "prompt", timestamp: 1 };
			const user = { role: "user", content: "hello", timestamp: 2 };
			const handler = pi.__handlers.get("context_with_system")?.[0];
			expect(handler).toBeDefined();

			const result = (await handler!(
				{ type: "context_with_system", messages: [leading, user] } as never,
				{} as never,
			)) as { messages: Array<Record<string, unknown>> };

			expect(result.messages).toHaveLength(3);
			expect(result.messages[0]).toBe(leading); // prompt stays at index 0
			const injected = result.messages[2] as {
				role: string;
				content: string;
				sections: Record<string, string>;
				timestamp: number;
			};
			expect(injected.role).toBe("system");
			expect(injected.sections.terminal_sessions).toContain("s_1");
			expect(injected.sections.terminal_sessions).toContain("cwd=C:/repo");
			expect(typeof injected.timestamp).toBe("number");
		} finally {
			for (const handler of pi.__handlers.get("session_shutdown") ?? []) {
				await handler({} as never, {} as never);
			}
		}
	});

	it("injects nothing when no live sessions exist", async () => {
		const pi = fakePi();
		smartTerminalExtension(pi as never);
		for (const handler of pi.__handlers.get("session_start") ?? []) {
			await handler(
				{ cwd: process.cwd() } as never,
				{ hasUI: false, ui: { setStatus: () => {}, notify: () => {} } } as never,
			);
		}
		runtime.manager = { list: () => [], destroyAll: () => {} } as never;
		try {
			const handler = pi.__handlers.get("context_with_system")?.[0];
			const result = await handler!(
				{ type: "context_with_system", messages: [{ role: "system", content: "p", timestamp: 1 }] } as never,
				{} as never,
			);
			expect(result).toBeUndefined();
		} finally {
			for (const handler of pi.__handlers.get("session_shutdown") ?? []) {
				await handler({} as never, {} as never);
			}
		}
	});
});
