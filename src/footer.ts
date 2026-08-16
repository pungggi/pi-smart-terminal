/**
 * Footer status line: shows the shared agent session and friends.
 *
 * Pure formatting lives here so it can be unit-tested without a PTY.
 */

import type { SessionInfo } from "./core.js";

export const FOOTER_STATUS_KEY = "smart-terminal";

export interface FooterTextOptions {
	/** Session id of the shared agent shell (gets a marker). */
	agentSessionId: string | null;
	/** Max characters for the rendered line. */
	maxWidth?: number;
}

function tailOfPath(cwd: string, maxSegments = 2): string {
	const normalized = cwd.replace(/[\\/]+/g, "/").replace(/\/$/, "");
	const segments = normalized.split("/").filter(Boolean);
	const tail = segments.slice(-maxSegments).join("/");
	return tail.length <= 32 ? tail : "…" + tail.slice(-31);
}

function statusGlyph(info: SessionInfo): string {
	if (!info.alive) return "✝";
	if (info.busy) return "⏵";
	return "◇";
}

/**
 * Build the one-line footer text. Returns undefined when there is nothing
 * to show (no sessions) so callers can clear the status slot.
 */
export function buildFooterText(sessions: SessionInfo[], opts: FooterTextOptions): string | undefined {
	if (sessions.length === 0) return undefined;

	const ordered = [...sessions].sort((a, b) => {
		if (a.id === opts.agentSessionId) return -1;
		if (b.id === opts.agentSessionId) return 1;
		return (b.lastActivity ?? "").localeCompare(a.lastActivity ?? "");
	});

	const primary = ordered[0];
	const parts: string[] = [
		`${statusGlyph(primary)} ${primary.id}`,
		primary.name ? `(${primary.name})` : null,
		tailOfPath(primary.cwd),
	].filter((p): p is string => Boolean(p));

	let line = `term: ${parts.join(" ")}`;
	const others = ordered.length - 1;
	if (others > 0) line += ` +${others}`;

	const maxWidth = opts.maxWidth ?? 80;
	if (line.length > maxWidth) line = line.slice(0, maxWidth - 1) + "…";

	return line;
}
