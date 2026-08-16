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

describe("buildFooterText · auto mode", () => {
	it("is silent while idle", () => {
		expect(buildFooterText([session()], { agentSessionId: null, mode: "auto" })).toBeUndefined();
	});

	it("shows busy count and cwd tail while busy", () => {
		expect(
			buildFooterText([session({ busy: true, cwd: "C:\\dev\\project" })], {
				agentSessionId: null,
				mode: "auto",
			}),
		).toBe("⏵ 1 · dev/project");
	});

	it("prefers the agent session and counts busy sessions only", () => {
		const text = buildFooterText(
			[
				{ ...session({ id: "agent", busy: true, lastActivity: "2026-01-01" }) },
			{ ...session({ id: "watch", busy: true, lastActivity: "2026-01-03" }) },
			{ ...session({ id: "idle-one", lastActivity: "2026-01-04" }) },
		],
			{ agentSessionId: "agent", mode: "auto" },
		);
		expect(text).toBe("⏵ 2 · dev/project");
	});

	it("lists exited session ids when nothing is busy", () => {
		const text = buildFooterText(
			[session({ id: "s3", alive: false }), session({ id: "s4", alive: false })],
			{ agentSessionId: null, mode: "auto" },
		);
		expect(text).toBe("✝ s3, s4");
	});
});

describe("buildFooterText · minimal mode", () => {
	it("shows glyph + count of the active state", () => {
		expect(buildFooterText([session()], { agentSessionId: null, mode: "minimal" })).toBe("◇ 1");
		expect(buildFooterText([session({ busy: true })], { agentSessionId: null, mode: "minimal" })).toBe("⏵ 1");
		expect(buildFooterText([session({ alive: false })], { agentSessionId: null, mode: "minimal" })).toBe("✝ 1");
	});

	it("counts busy sessions preferentially", () => {
		const text = buildFooterText(
			[session({ busy: true }), session(), session({ alive: false })],
			{ agentSessionId: null, mode: "minimal" },
		);
		expect(text).toBe("⏵ 1");
	});
});

describe("buildFooterText · off mode", () => {
	it("never renders", () => {
		expect(
			buildFooterText([session({ busy: true })], { agentSessionId: null, mode: "off" }),
		).toBeUndefined();
	});
});
