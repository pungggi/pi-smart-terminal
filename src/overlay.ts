/**
 * Live terminal session overlay (/term).
 *
 * A read-only viewer for any active PTY session: watch agent-run commands
 * stream in real time, scroll back through history, follow the tail.
 *
 * Keys:  q / Esc  close ·  ↑ ↓ scroll ·  PgUp/PgDn page ·  Home/End jump
 *        f        re-enable follow mode (tail)
 */

import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

import type { PtySession } from "./core.js";

const POLL_INTERVAL_MS = 150;

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

export class TerminalView {
	private readonly session: PtySession;
	private readonly theme: Theme;
	private readonly requestRender: () => void;
	private readonly done: () => void;
	private readonly height: number;

	private viewport: ViewportState = { offset: 0, follow: true };
	private totalLines = 0;
	private lastRenderWidth = -1;

	constructor(opts: {
		session: PtySession;
		theme: Theme;
		requestRender: () => void;
		done: () => void;
		height: number;
	}) {
		this.session = opts.session;
		this.theme = opts.theme;
		this.requestRender = opts.requestRender;
		this.done = opts.done;
		this.height = Math.max(6, opts.height);
	}

	close(): void {
		this.done();
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || data === "q") {
			this.close();
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
		return this.height - 4; // header (2) + footer (2)
	}

	render(width: number): string[] {
		this.lastRenderWidth = width;
		const t = this.theme;
		const bodyHeight = this.bodyHeight();

		const history = this.session.getHistory({ offset: 0, limit: 10000, format: "lines" });
		const lines = history.lines;
		this.totalLines = history.totalLines;

		const range = computeVisibleRange(this.viewport, lines.length, bodyHeight);
		const visible = lines.slice(Math.max(0, range.start - 0), range.end);

		const out: string[] = [];
		const info = this.session.getInfo({ verbose: false });
		const state = !info.alive ? "EXITED" : info.busy ? "BUSY" : "IDLE";
		const stateColor: ThemeColor = !info.alive ? "error" : info.busy ? "warning" : "success";

		const title = ` smart-terminal · ${this.session.id}${this.session.name ? ` (${this.session.name})` : ""} `;
		out.push(t.bg("customMessageBg", t.fg(stateColor, title.padEnd(width - 1).slice(0, width - 1))));

		const cwd = truncateToWidth(` ${this.session.cwd} · ${this.session.shell ?? ""} · ${state}`, width);
		out.push(t.fg("muted", cwd));

		if (visible.length === 0) {
			out.push(t.fg("dim", " (no output yet — waiting for data…)"));
		} else {
			for (const line of visible) {
				out.push(truncateToWidth(` ${line}`, width));
			}
		}

		while (out.length < 2 + bodyHeight) out.push("");

		const followTag = range.following ? "following" : `offset ${this.viewport.offset}`;
		const help = ` q close · ↑↓ PgUp/PgDn scroll · f follow · ${followTag} · ${this.totalLines} lines`;
		out.push(t.fg("dim", truncateToWidth(help, width)));

		return out;
	}

	invalidate(): void {
		this.lastRenderWidth = -1;
	}

	poll(): void {
		this.requestRender();
	}
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
