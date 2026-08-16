import { describe, expect, it } from "vitest";

import { buildFooterText } from "../src/footer.js";
import type { SessionInfo } from "../src/core.js";

function session(overrides: Partial<SessionInfo> = {}): SessionInfo {
	return {
		id: "calm-reef",
		name: null,
		cwd: "C:\\dev\\project",
		alive: true,
		busy: false,
		...overrides,
	};
}

describe("buildFooterText", () => {
	it("returns undefined with no sessions", () => {
		expect(buildFooterText([], { agentSessionId: null })).toBeUndefined();
	});

	it("shows idle glyph, id and cwd tail", () => {
		expect(buildFooterText([session()], { agentSessionId: null })).toBe(
			"term: ◇ calm-reef dev/project",
		);
	});

	it("marks busy and exited sessions", () => {
		expect(buildFooterText([session({ busy: true })], { agentSessionId: "calm-reef" })).toBe(
			"term: ⏵ calm-reef dev/project",
		);
		expect(buildFooterText([session({ alive: false })], { agentSessionId: null })).toBe(
			"term: ✝ calm-reef dev/project",
		);
	});

	it("sorts the agent session first and counts the rest", () => {
		const text = buildFooterText(
			[session({ id: "other", lastActivity: "2026-01-02" }), session({ lastActivity: "2026-01-01" })],
			{ agentSessionId: "calm-reef" },
		);
		expect(text).toBe("term: ◇ calm-reef dev/project +1");
	});

	it("includes the session name when present", () => {
		expect(buildFooterText([session({ name: "agent" })], { agentSessionId: null })).toBe(
			"term: ◇ calm-reef (agent) dev/project",
		);
	});

	it("truncates long lines with an ellipsis", () => {
		const text = buildFooterText([session({ cwd: "C:\\" + "very-long-folder-name\\nested\\deep\\" + "x".repeat(60) })], {
			agentSessionId: null,
			maxWidth: 30,
		});
		expect(text!.length).toBe(30);
		expect(text!.endsWith("…")).toBe(true);
	});
});
