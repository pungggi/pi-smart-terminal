/**
 * Configuration for pi-smart-terminal.
 *
 * Read from `~/.pi/agent/smart-terminal.json` (all keys optional):
 *
 * ```json
 * {
 *   "overrideBash": true,
 *   "userBash": false,
 *   "bashTimeoutMs": 600000,
 *   "footer": true,
 *   "defaultShell": null,
 *   "allToolsActive": false
 * }
 * ```
 */

export interface SmartTerminalConfig {
	/** Replace the built-in bash tool with a persistent PTY-backed session. */
	overrideBash: boolean;
	/** Route user `!` commands through the shared persistent session (opt-in). */
	userBash: boolean;
	/** Hard cap in ms for a bash command when the model passes no timeout. */
	bashTimeoutMs: number;
	/** Show a footer status line with active session info. */
	footer: boolean;
	/** Force a specific shell for the agent session (null = auto-detect). */
	defaultShell: string | null;
	/** Register all terminal tools active instead of behind the loader. */
	allToolsActive: boolean;
}

export const DEFAULT_CONFIG: SmartTerminalConfig = {
	overrideBash: true,
	userBash: false,
	bashTimeoutMs: 10 * 60 * 1000,
	footer: true,
	defaultShell: null,
	allToolsActive: false,
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** Merge a parsed JSON config file over the defaults. Unknown keys are ignored. */
export function mergeConfig(parsed: unknown, base: SmartTerminalConfig = DEFAULT_CONFIG): SmartTerminalConfig {
	if (!isRecord(parsed)) return { ...base };

	const merged: SmartTerminalConfig = { ...base };

	if (typeof parsed.overrideBash === "boolean") merged.overrideBash = parsed.overrideBash;
	if (typeof parsed.userBash === "boolean") merged.userBash = parsed.userBash;
	if (typeof parsed.bashTimeoutMs === "number" && Number.isFinite(parsed.bashTimeoutMs) && parsed.bashTimeoutMs >= 1000) {
		merged.bashTimeoutMs = Math.floor(parsed.bashTimeoutMs);
	}
	if (typeof parsed.footer === "boolean") merged.footer = parsed.footer;
	if (typeof parsed.defaultShell === "string" && parsed.defaultShell.length > 0) merged.defaultShell = parsed.defaultShell;
	if (typeof parsed.allToolsActive === "boolean") merged.allToolsActive = parsed.allToolsActive;

	return merged;
}
