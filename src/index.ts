/**
 * pi-smart-terminal — persistent PTY terminal sessions for pi.
 *
 * Deep integration:
 *  - Overrides the built-in bash tool with a persistent PTY-backed session
 *    (keeps pi's native rendering/truncation via createBashTool operations).
 *  - Registers the terminal_* tool family with pi-native dynamic loading.
 *  - /term live session overlay, /terminals listing, footer status line.
 *  - Optional: routes user `!` commands through the shared session.
 *  - Cleans up every PTY on session_shutdown.
 *
 * The native node-pty chain (via smart-terminal-mcp) is loaded lazily and
 * defensively: if the module cannot load, pi starts normally without this
 * extension's tools and shows a single error notification.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
	createBashToolDefinition,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { DEFAULT_CONFIG, mergeConfig, type SmartTerminalConfig } from "./config.js";
import { FOOTER_STATUS_KEY, buildFooterText } from "./footer.js";
import { tuiHeight } from "./overlay.js";

// These modules transitively import node-pty — loaded lazily in ensureLoaded().
type LazyModules = {
	tools: typeof import("./tools.js");
	bashBackend: typeof import("./bash-backend.js");
	runtime: typeof import("./runtime.js");
};

export default function smartTerminalExtension(pi: ExtensionAPI) {
	const config = loadConfigFile();

	let modules: LazyModules | null = null;
	let loadError: string | null = null;
	let loadPromise: Promise<void> | null = null;
	let footerTimer: ReturnType<typeof setInterval> | null = null;
	let lastRegisteredCwd: string | null = null;

	function ensureLoaded(): Promise<void> {
		loadPromise ??= (async () => {
			try {
				// Probe the native chain first so a missing/incompatible native
				// build surfaces here instead of breaking half the extension.
				await import("./core.js");
				const [tools, bashBackend, runtime] = await Promise.all([
					import("./tools.js"),
					import("./bash-backend.js"),
					import("./runtime.js"),
				]);
				modules = { tools, bashBackend, runtime };
			} catch (err) {
				loadError = (err as Error)?.message ?? String(err);
			}
		})();
		return loadPromise;
	}

	async function registerSessionScoped(cwd: string): Promise<void> {
		if (!modules) return;

		// terminal tools + loader (idempotent re-registration per session)
		modules.tools.registerTerminalTools(pi);
		modules.tools.applyInitialActiveTools(pi, config.allToolsActive);

		// Bash override: pi's native bash tool with a persistent PTY backend.
		// Registered per session so the tool's declared cwd matches reality.
		if (config.overrideBash && cwd !== lastRegisteredCwd) {
			const operations = modules.bashBackend.createPtyBashOperations(config);
			const bashTool = createBashToolDefinition(cwd, { operations });
			pi.registerTool({
				...bashTool,
				promptGuidelines: [
					...(bashTool.promptGuidelines ?? []),
					"The bash tool runs in a persistent PTY session: working directory, environment variables and background processes persist across calls. Use terminal_list to inspect sessions and terminal_read to fetch output of commands still running.",
				],
			});
			lastRegisteredCwd = cwd;
		}
	}

	function refreshFooter(ui: ExtensionContext["ui"]): void {
		if (!modules) return;
		const sessions = modules.runtime.runtime.manager?.list({ verbose: true }) ?? [];
		const text = buildFooterText(sessions, {
			agentSessionId: modules.runtime.runtime.agentSessionId,
		});
		ui.setStatus(FOOTER_STATUS_KEY, text);
	}

	pi.on("session_start", async (_event, ctx) => {
		await ensureLoaded();

		if (!modules) {
			if (ctx.hasUI) {
				ctx.ui.notify(`smart-terminal: disabled — native PTY load failed: ${loadError}`, "error");
			}
			return;
		}

		await registerSessionScoped(ctx.cwd);

		if (config.footer) {
			refreshFooter(ctx.ui);
			footerTimer = setInterval(() => refreshFooter(ctx.ui), 2000);
		}
	});

	pi.on("session_shutdown", async () => {
		if (footerTimer) clearInterval(footerTimer);
		footerTimer = null;
		// PTY cleanup — no orphaned processes when pi exits or switches sessions.
		modules?.runtime.destroyRuntime();
	});

	pi.on("user_bash", async () => {
		if (!config.userBash || !modules) return undefined;
		// Route `!` commands through the same persistent session the agent
		// uses. Full-screen interactive commands (!vim…) keep pi's native
		// behavior; that's why this is opt-in via config.
		return { operations: modules.bashBackend.createPtyBashOperations(config) };
	});

	// /term — live session overlay
	pi.registerCommand("term", {
		description: "Live view of a terminal session (↑↓/PgUp/PgDn scroll, f follow, q close)",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui" || !modules) {
				ctx.ui.notify("smart-terminal not available in this mode.", "warning");
				return;
			}
			const manager = modules.runtime.runtime.manager;
			if (!manager || manager.list().length === 0) {
				ctx.ui.notify("No active terminal sessions yet — run a bash command first.", "info");
				return;
			}

			const sessions = manager.list({ verbose: false });
			let target = sessions[0];
			if (sessions.length > 1) {
				const choice = await ctx.ui.select(
					"Session:",
					sessions.map((s) => s.id),
				);
				if (choice === undefined) return;
				target = sessions.find((s) => s.id === choice) ?? sessions[0];
			}

			const session = manager.get(target.id);
			const { TerminalView, startPolling, stopPolling } = await import("./overlay.js");

			await ctx.ui.custom((tui, theme, _keybindings, done) => {
				const requestRender = () => (tui as { requestRender: () => void }).requestRender();
				let handle: ReturnType<typeof startPolling> | null = null;

				const view = new TerminalView({
					session,
					theme,
					height: tuiHeight(tui),
					requestRender,
					done: () => {
						stopPolling(handle);
						done(undefined);
					},
				});
				handle = startPolling(view);
				return view as never;
			});
		},
	});

	// /terminals — quick session listing
	pi.registerCommand("terminals", {
		description: "List active terminal sessions",
		handler: async (_args, ctx) => {
			const manager = modules?.runtime.runtime.manager;
			const sessions = manager?.list({ verbose: true }) ?? [];
			if (sessions.length === 0) {
				ctx.ui.notify("No active terminal sessions.", "info");
				return;
			}
			const lines = sessions.map(
				(s) =>
					`${s.alive ? "●" : "○"} ${s.id}${s.name ? ` (${s.name})` : ""} ${s.busy ? "[busy]" : ""} ${s.cwd ?? ""}`,
			);
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}

function loadConfigFile(): SmartTerminalConfig {
	const path = join(homedir(), ".pi", "agent", "smart-terminal.json");
	try {
		return mergeConfig(JSON.parse(readFileSync(path, "utf-8")), DEFAULT_CONFIG);
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}
