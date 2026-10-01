import { describe, expect, it } from "vitest";

import { TERMINAL_SESSIONS_SECTION, buildSessionStateSection } from "../src/context-state.js";
import type { SessionInfo } from "../src/core.js";

function session(overrides: Partial<SessionInfo> = {}): SessionInfo {
	return {
		id: "s_1",
		name: null,
		cwd: "C:\\repo\\packages\\api",
		alive: true,
		busy: false,
		...overrides,
	};
}

describe("TERMINAL_SESSIONS_SECTION", () => {
	it("is a valid pi system-prompt section name", () => {
		expect(TERMINAL_SESSIONS_SECTION).toMatch(/^[a-z][a-z0-9_-]*$/);
		expect(TERMINAL_SESSIONS_SECTION).not.toBe("preamble");
	});
});

describe("buildSessionStateSection", () => {
	it("returns empty string when there are no sessions", () => {
		expect(buildSessionStateSection([])).toBe("");
	});

	it("returns empty string when no session is alive", () => {
		expect(buildSessionStateSection([session({ alive: false })])).toBe("");
	});

	it("lists id, shell type, cwd (forward slashes) and idle/busy state", () => {
		const section = buildSessionStateSection([
			session({ id: "s_1", shellType: "pwsh", cwd: "C:\\repo\\api", busy: false, idleSeconds: 12 }),
		]);
		expect(section).toContain("- s_1 pwsh cwd=C:/repo/api idle (12s)");
		expect(section).toContain("terminal_* tools");
	});

	it("marks busy sessions and omits their idle seconds", () => {
		const section = buildSessionStateSection([session({ busy: true, idleSeconds: 5 })]);
		expect(section).toContain("busy");
		expect(section).not.toContain("(5s)");
	});

	it("includes the session name when present", () => {
		const section = buildSessionStateSection([session({ name: "dev-server" })]);
		expect(section).toContain('"dev-server"');
	});

	it("one line per alive session, dead sessions skipped", () => {
		const section = buildSessionStateSection([
			session({ id: "s_a" }),
			session({ id: "s_dead", alive: false }),
			session({ id: "s_b" }),
		]);
		expect(section).toContain("- s_a ");
		expect(section).toContain("- s_b ");
		expect(section).not.toContain("s_dead");
	});
});
