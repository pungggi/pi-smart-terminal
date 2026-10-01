/**
 * Per-request terminal-session state for the model context (pi ≥ 0.87).
 *
 * A `context_with_system` handler appends one trailing system message whose
 * `terminal_sessions` prompt section lists the live sessions — the same
 * mechanism pi uses for its `mcp_servers` section. Because the handler runs
 * on the raw transcript on every request and its output is never persisted:
 *
 *  - the model always knows its sessionIds and their *current* cwd, even
 *    after compaction (which would otherwise orphan that knowledge while
 *    the PTYs keep running);
 *  - cwd drift becomes visible per request instead of only in the footer;
 *  - history stays clean (nothing is appended to the transcript);
 *  - the provider prefix remains cache-stable (only the trailing block
 *    changes between requests).
 */

import type { SessionInfo } from "./core.js";

/** Prompt-section name (must match /^[a-z][a-z0-9_-]*$/, not "preamble"). */
export const TERMINAL_SESSIONS_SECTION = "terminal_sessions";

/**
 * Compact one-line-per-session state block. Empty string when no live
 * sessions (the handler then injects nothing at all).
 */
export function buildSessionStateSection(sessions: SessionInfo[]): string {
	const alive = sessions.filter((s) => s.alive);
	if (alive.length === 0) return "";
	const lines = alive.map((s) => {
		const parts = [`- ${s.id}`];
		if (s.name) parts.push(`"${s.name}"`);
		if (s.shellType) parts.push(s.shellType);
		if (s.cwd) parts.push(`cwd=${s.cwd.replace(/\\/g, "/")}`);
		parts.push(s.busy ? "busy" : "idle");
		if (!s.busy && s.idleSeconds !== undefined) parts.push(`(${Math.round(s.idleSeconds)}s)`);
		return parts.join(" ");
	});
	return [
		"Live smart-terminal sessions (kept current by the harness; pass these sessionIds to terminal_* tools):",
		...lines,
	].join("\n");
}
