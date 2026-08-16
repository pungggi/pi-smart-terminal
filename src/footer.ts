/**
 * Footer status line modes.
 *
 *   auto    → hidden while idle; appears only while a command runs or after
 *             a session exited (the states that need attention)
 *   minimal → always-on state glyph + count
 *   full    → verbose: term: glyph id (name) cwd-tail +N
 *
 * Pure formatting lives here so it can be unit-tested without a PTY.
 */

import type { SessionInfo } from "./core.js";
import type { FooterMode } from "./config.js";

export const FOOTER_STATUS_KEY = "smart-terminal";

export interface FooterTextOptions {
	/** Session id of the shared agent shell (gets a marker). */
	agentSessionId: string | null;
	/** Footer mode (default: "full" — kept for callers that predate modes). */
	mode?: FooterMode;
	/** Max characters for the rendered line. */
	maxWidth?: number;
}

function tailOfPath(cwd: string, maxSegments = 2, maxLen = 32): string {
	const normalized = cwd.replace(/[\\/]+/g, "/").replace(/\/$/, "");
	const segments = normalized.split("/").filter(Boolean);
	const tail = segments.slice(-maxSegments).join("/");
	return tail.length <= maxLen ? tail : "…" + tail.slice(-(maxLen - 1));
}

function statusGlyph(info: SessionInfo): string {
	if (!info.alive) return "✝";
	if (info.busy) return "⏵";
	return "◇";
}

function pickPrimary(sessions: SessionInfo[], agentSessionId: string | null): SessionInfo {
	const ordered = [...sessions].sort((a, b) => {
		if (a.id === agentSessionId) return -1;
		if (b.id === agentSessionId) return 1;
		return (b.lastActivity ?? "").localeCompare(a.lastActivity ?? "");
	});
	return ordered[0];
}

function truncate(line: string, maxWidth: number): string {
	return line.length > maxWidth ? line.slice(0, maxWidth - 1) + "…" : line;
}

/** auto: only busy and exited states produce output; idle is silent. */
function autoLine(sessions: SessionInfo[], agentSessionId: string | null): string | undefined {
	const busy = sessions.filter((s) => s.alive && s.busy);
	if (busy.length > 0) {
		const primary = pickPrimary(busy, agentSessionId);
		return `⏵ ${busy.length} · ${tailOfPath(primary.cwd, 2, 24)}`;
	}
	const dead = sessions.filter((s) => !s.alive);
	if (dead.length > 0) return `✝ ${dead.map((s) => s.id).join(", ")}`;
	return undefined;
}

/** minimal: always-on glyph + count of the sessions in that state. */
function minimalLine(sessions: SessionInfo[]): string {
	const busy = sessions.filter((s) => s.alive && s.busy).length;
	if (busy > 0) return `⏵ ${busy}`;
	const dead = sessions.filter((s) => !s.alive).length;
	if (dead > 0) return `✝ ${dead}`;
	return `◇ ${sessions.length}`;
}

/** full: the classic verbose line. */
function fullLine(sessions: SessionInfo[], agentSessionId: string | null): string | undefined {
	const primary = pickPrimary(sessions, agentSessionId);
	const parts: string[] = [
		`${statusGlyph(primary)} ${primary.id}`,
		primary.name ? `(${primary.name})` : null,
		tailOfPath(primary.cwd),
	].filter((p): p is string => Boolean(p));

	let line = `term: ${parts.join(" ")}`;
	const others = sessions.length - 1;
	if (others > 0) line += ` +${others}`;
	return line;
}

/**
 * Build the one-line footer text. Returns undefined when there is nothing
 * to show (no sessions, or idle in auto mode) so callers can clear the
 * status slot.
 */
export function buildFooterText(sessions: SessionInfo[], opts: FooterTextOptions): string | undefined {
	if (sessions.length === 0) return undefined;

	let line: string | undefined;
	switch (opts.mode ?? "full") {
		case "auto":
			line = autoLine(sessions, opts.agentSessionId);
			break;
		case "minimal":
			line = minimalLine(sessions);
			break;
		case "off":
			line = undefined;
			break;
		case "full":
		default:
			line = fullLine(sessions, opts.agentSessionId);
			break;
	}
	if (line === undefined) return undefined;
	return truncate(line, opts.maxWidth ?? 80);
}
