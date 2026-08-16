/**
 * Live terminal session overlay (/term).
 *
 * A read-only viewer for active PTY sessions: watch agent-run commands
 * stream in real time, scroll back through history, follow the tail, and
 * switch between sessions without leaving the overlay.
 *
 * Keys:  q / Esc  close ·  ↑ ↓ scroll ·  PgUp/PgDn page ·  Home/End jump
 *        f        re-enable follow mode (tail)
 *        Tab / Shift+Tab   next / previous session
 */

import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

import type { PtySession } from "./core.js";

const POLL_INTERVAL_MS = 150;

/** Minimal session registry surface the overlay needs (SessionManager subset). */
export interface SessionSource {
	list(): Array<{ id: string; name: string | null }>;
	get(id: string): PtySession | undefined;
}

/** Pure viewport math (unit-tested). `offset` counts lines back from the end. */
export interface ViewportState {
	offset: number;
	follow: boolean;
}

export function clampOffset(offset: number, totalLines: number): number {
	if (totalLines <= 0) return 0;
	return Math.max(0, Math.min(offset, totalLines - 1));
}

export function scrollViewport(state: ViewportState, delta: number, totalLines: number): ViewportState {
	const nextOffset = clampOffset(state.offset + delta, totalLines);
	return { offset: nextOffset, follow: nextOffset === 0 };
}

export interface VisibleRange {
	start: number; // inclusive absolute line index
	end: number; // exclusive
	following: boolean;
}

export function computeVisibleRange(
	state: ViewportState,
	totalLines: number,
	bodyHeight: number,
): VisibleRange {
	const offset = state.follow ? 0 : clampOffset(state.offset, totalLines);
	const end = Math.max(0, totalLines - offset);
	const start = Math.max(0, end - bodyHeight);
	return { start, end, following: state.follow };
}

/** Index of the session `delta` steps from `current` (wraps). 0 for unknown. */
export function nextSessionIndex(ids: string[], current: string, delta: number): number {
	if (ids.length === 0) return -1;
	const i = ids.indexOf(current);
	if (i === -1) return 0;
	return (i + delta + ids.length) % ids.length;
}

/**
 * Scroll position as a percentage of the scrollable range.
 * null means "at the tail" (nothing to scroll / following).
 */
export function scrollPercent(
	state: ViewportState,
	totalLines: number,
	bodyHeight: number,
): number | null {
	const scrollable = Math.max(0, totalLines - bodyHeight);
	if (state.follow || scrollable <= 0) return null;
	const offset = state.follow ? 0 : clampOffset(state.offset, totalLines);
	return Math.round(((scrollable - offset) / scrollable) * 100);
}

export class TerminalView {
	private readonly source: SessionSource;
	private readonly theme: Theme;
	private readonly requestRender: () => void;
	private readonly done: () => void;
	private readonly height: number;

	private currentId: string;
	private viewport: ViewportState = { offset: 0, follow: true };
	private totalLines = 0;
	private lastRenderWidth = -1;

	constructor(opts: {
		source: SessionSource;
		initialSessionId: string;
		theme: Theme;
		requestRender: () => void;
		done: () => void;
		height: number;
	}) {
		this.source = opts.source;
		this.currentId = opts.initialSessionId;
		this.theme = opts.theme;
		this.requestRender = opts.requestRender;
		this.done = opts.done;
		this.height = Math.max(6, opts.height);
	}

	close(): void {
		this.done();
	}

	private switchSession(delta: number): void {
		const entries = this.source.list();
		if (entries.length < 2) return;
		const ids = entries.map((e) => e.id);
		const idx = nextSessionIndex(ids, this.currentId, delta);
		if (ids[idx] === this.currentId) return;
		this.currentId = ids[idx];
		this.viewport = { offset: 0, follow: true };
		this.requestRender();
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || data === "q") {
			this.close();
			return;
		}
		if (matchesKey(data, Key.shift(Key.tab)) || data === "\x1b[Z") {
			this.switchSession(-1);
			return;
		}
		if (matchesKey(data, Key.tab) || data === "\t") {
			this.switchSession(1);
			return;
		}
		if (matchesKey(data, Key.up)) {
			this.viewport = scrollViewport(this.viewport, 1, this.totalLines);
		} else if (matchesKey(data, Key.down)) {
			this.viewport = scrollViewport(this.viewport, -1, this.totalLines);
		} else if (matchesKey(data, Key.pageUp)) {
			this.viewport = scrollViewport(this.viewport, this.bodyHeight(), this.totalLines);
		} else if (matchesKey(data, Key.pageDown)) {
			this.viewport = scrollViewport(this.viewport, -this.bodyHeight(), this.totalLines);
		} else if (matchesKey(data, Key.home)) {
			this.viewport = { offset: Math.max(0, this.totalLines - 1), follow: false };
		} else if (matchesKey(data, Key.end) || data === "f") {
			this.viewport = { offset: 0, follow: true };
		} else {
			return;
		}
		this.requestRender();
	}

	private bodyHeight(): number {
		return this.height - 4; // header (2) + footer (1) + spacer handled by caller
	}

	/** Current session, falling back to the newest one if it vanished. */
	private currentSession(): PtySession | null {
		const entries = this.source.list();
		if (entries.length === 0) return null;
		const known = entries.some((e) => e.id === this.currentId);
		if (!known) {
			this.currentId = entries[0].id;
			this.viewport = { offset: 0, follow: true };
		}
		return this.source.get(this.currentId) ?? null;
	}

	render(width: number): string[] {
		this.lastRenderWidth = width;
		const t = this.theme;
		const bodyHeight = this.bodyHeight();

		const entries = this.source.list();
		const session = this.currentSession();
		const multi = entries.length > 1;
		const idx = entries.findIndex((e) => e.id === this.currentId);

		const sessionInfo = session?.getInfo({ verbose: false }) ?? null;
		const alive = sessionInfo?.alive ?? false;
		const busy = sessionInfo?.busy ?? false;

		let lines: string[] = [];
		if (session) {
			const history = session.getHistory({ offset: 0, limit: 10000, format: "lines" });
			lines = history.lines;
			this.totalLines = history.totalLines;
		} else {
			this.totalLines = 0;
		}

		const range = computeVisibleRange(this.viewport, lines.length, bodyHeight);
		const visible = lines.slice(range.start, range.end);

		const out: string[] = [];

		// ── Header line 1: title left, state badge right, on a colored bar ──
		const stateColor: ThemeColor = !alive ? "error" : busy ? "warning" : "success";
		const badge = !alive ? "✝ EXITED " : busy ? "⏵ BUSY " : "◇ IDLE ";
		const title = ` smart-terminal${multi && idx >= 0 ? `  ${idx + 1}/${entries.length}` : ""} `;
		const gap = Math.max(1, width - title.length - badge.length);
		const bar = title + " ".repeat(gap) + badge;
		out.push(t.bg("customMessageBg", t.fg(stateColor, truncateToWidth(bar, width))));

		// ── Header line 2: grouped session facts ──
		const infoParts: string[] = [` ${this.currentId}`];
		if (session?.shell) infoParts.push(session.shell);
		if (this.totalLines > 0) infoParts.push(`${this.totalLines} lines`);
		if (session?.cwd) infoParts.push(tailOfCwd(session.cwd));
		const info = infoParts.join(" · ");
		out.push(t.fg("muted", truncateToWidth(info, width)));
		// ── Body ──
		if (!session) {
			out.push(t.fg("dim", " (session closed — no active sessions)"));
		} else if (visible.length === 0) {
			out.push(t.fg("dim", " (no output yet — waiting for data…)"));
		} else {
			for (const line of visible) {
				out.push(truncateToWidth(` ${line}`, width));
			}
		}

		while (out.length < 2 + bodyHeight) out.push("");

		// ── Status bar: scroll position · session/follow · keymap ──
		out.push(this.renderStatusBar(width, range, multi, idx, entries.length));

		return out;
	}

	private renderStatusBar(
		width: number,
		range: VisibleRange,
		multi: boolean,
		idx: number,
		total: number,
	): string {
		const pct = scrollPercent(this.viewport, this.totalLines, this.bodyHeight());
		const left = range.following || pct === null ? "↓ tail" : `${pct}% ▲`;
		const centre = `${this.currentId}${multi && idx >= 0 ? ` ${idx + 1}/${total}` : ""} · ${
			range.following ? "following" : "paused"
		}`;
		const right = `q close${multi ? " · Tab next" : ""} · f follow`;

		const pad = width - 1 - left.length - centre.length - right.length;
		let line: string;
		if (pad >= 4) {
			const gap1 = " ".repeat(Math.floor(pad / 2));
			const gap2 = " ".repeat(Math.ceil(pad / 2));
			line = ` ${left}${gap1}${centre}${gap2}${right}`;
		} else {
			// too narrow: drop the keymap zone
			line = truncateToWidth(` ${left}  ${centre}`, width);
		}
		return this.theme.fg("dim", line);
	}

	invalidate(): void {
		this.lastRenderWidth = -1;
	}

	poll(): void {
		this.requestRender();
	}
}

function tailOfCwd(cwd: string, maxLen = 40): string {
	const normalized = cwd.replace(/[\\/]+/g, "/").replace(/\/$/, "");
	return normalized.length <= maxLen ? normalized : "…" + normalized.slice(-(maxLen - 1));
}

export function startPolling(view: TerminalView): ReturnType<typeof setInterval> {
	return setInterval(() => view.poll(), POLL_INTERVAL_MS);
}

export function stopPolling(handle: ReturnType<typeof setInterval> | null): void {
	if (handle) clearInterval(handle);
}

export function tuiHeight(tui: unknown): number {
	const maybe = tui as { rows?: number; height?: number } | null;
	return maybe?.rows ?? maybe?.height ?? 30;
}
