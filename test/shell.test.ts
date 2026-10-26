import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	POWERSHELL_ARGS,
	SHELL_ENV,
	SHELL_PIN_ENV,
	SHELL_TYPE_ENV,
	assertSupportedInShell,
	getResolvedShell,
	resetResolvedShell,
	resolveShell,
	sessionShell,
	shellArgsFor,
	shellDialect,
	shellGuideline,
} from "../src/shell.js";

/** Probes/locales injected so tests never touch the real PATH. */
const env = (pin?: string) => ({ [SHELL_PIN_ENV]: pin });
const probe =
	(...available: string[]) =>
	(exe: string) =>
		available.includes(exe);
const detect = (shell: string) => () => ({ shell, args: [] });

const originalPin = process.env[SHELL_PIN_ENV];
const originalShell = process.env[SHELL_ENV];
const originalShellType = process.env[SHELL_TYPE_ENV];

beforeEach(() => resetResolvedShell());
afterEach(() => {
	resetResolvedShell();
	// getResolvedShell exports PI_SHELL/PI_SHELL_TYPE — restore the sandbox.
	if (originalPin === undefined) delete process.env[SHELL_PIN_ENV];
	else process.env[SHELL_PIN_ENV] = originalPin;
	if (originalShell === undefined) delete process.env[SHELL_ENV];
	else process.env[SHELL_ENV] = originalShell;
	if (originalShellType === undefined) delete process.env[SHELL_TYPE_ENV];
	else process.env[SHELL_TYPE_ENV] = originalShellType;
});

describe("resolveShell precedence", () => {
	it("prefers the PI_TERMINAL_SHELL env pin over config", () => {
		const resolved = resolveShell("cmd.exe", {
			env: env("powershell.exe"),
			probe: probe("powershell.exe", "cmd.exe"),
			detect: detect("pwsh.exe"),
		});
		expect(resolved).toEqual({ shell: "powershell.exe", shellType: "powershell", source: "env" });
	});

	it("falls back to config defaultShell when no env pin", () => {
		const resolved = resolveShell("cmd.exe", {
			env: env(),
			probe: probe("cmd.exe", "pwsh.exe"),
			detect: detect("pwsh.exe"),
		});
		expect(resolved).toEqual({ shell: "cmd.exe", shellType: "cmd", source: "config" });
	});

	it("auto-detects when nothing is pinned", () => {
		const resolved = resolveShell(null, { env: env(), detect: detect("pwsh.exe") });
		expect(resolved).toEqual({ shell: "pwsh.exe", shellType: "powershell", source: "detected" });
	});

	it("treats a blank pin as absent", () => {
		const resolved = resolveShell("  ", { env: env("   "), detect: detect("bash") });
		expect(resolved).toEqual({ shell: "bash", shellType: "bash", source: "detected" });
	});
});

describe("invalid pins fail loudly", () => {
	it("throws an actionable error naming the env override and the auto-detect pick", () => {
		expect(() =>
			resolveShell(null, {
				env: env("noshell"),
				probe: probe(),
				detect: detect("powershell.exe"),
			}),
		).toThrowError(/PI_TERMINAL_SHELL="noshell".*would pick powershell\.exe/s);
	});

	it("throws for an unusable config defaultShell", () => {
		expect(() =>
			resolveShell("nope", { env: env(), probe: probe(), detect: detect("pwsh.exe") }),
		).toThrowError(/defaultShell "nope".*auto-detect/s);
	});

	it.runIf(process.platform === "win32")("resolves a bare name to its executable extension on Windows", () => {
		const resolved = resolveShell("pwsh", {
			env: env(),
			probe: probe("pwsh.exe"),
			detect: detect("powershell.exe"),
		});
		expect(resolved).toEqual({ shell: "pwsh.exe", shellType: "powershell", source: "config" });
	});
});

describe("getResolvedShell memoization + exposure", () => {
	it("pins the first resolution and ignores later config changes", () => {
		const first = getResolvedShell(null, { env: env(), detect: detect("pwsh.exe") });
		const second = getResolvedShell("cmd.exe", {
			env: env(),
			probe: probe("cmd.exe"),
			detect: detect("powershell.exe"),
		});
		expect(second).toBe(first);
		expect(second.source).toBe("detected");
	});

	it("exports PI_SHELL / PI_SHELL_TYPE for child processes and scripts", () => {
		getResolvedShell(null, { env: env(), detect: detect("powershell.exe") });
		expect(process.env[SHELL_ENV]).toBe("powershell.exe");
		expect(process.env[SHELL_TYPE_ENV]).toBe("powershell");
	});

	it("reports a previously exported pin as reused", () => {
		getResolvedShell("cmd.exe", { env: env(), probe: probe("cmd.exe"), detect: detect("pwsh.exe") });
		expect(getResolvedShell(null, { env: env(), detect: detect("pwsh.exe") }).source).toBe("config");
	});
});

describe("sessionShell", () => {
	it("lets upstream auto-detect handle unpinned shells (keeps -NoLogo/-NoProfile)", () => {
		expect(sessionShell({ shell: "pwsh.exe", shellType: "powershell", source: "detected" })).toBeUndefined();
	});

	it("forwards an explicit pin so create() uses exactly it", () => {
		expect(sessionShell({ shell: "cmd.exe", shellType: "cmd", source: "env" })).toBe("cmd.exe");
		expect(sessionShell({ shell: "cmd.exe", shellType: "cmd", source: "config" })).toBe("cmd.exe");
	});
});

describe("shellArgsFor", () => {
	it("keeps the PowerShell family non-interactive and profile-free", () => {
		expect(shellArgsFor("pwsh.exe")).toEqual(POWERSHELL_ARGS);
		expect(shellArgsFor("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")).toEqual(POWERSHELL_ARGS);
	});

	it("adds no args to other shells", () => {
		expect(shellArgsFor("cmd.exe")).toEqual([]);
		expect(shellArgsFor("bash")).toEqual([]);
	});
});

describe("assertSupportedInShell", () => {
	it("rejects multi-line payloads in cmd sessions with the workaround", () => {
		expect(() => assertSupportedInShell("echo a\necho b", "cmd")).toThrowError(
			/Multi-line commands are rejected in a cmd\.exe session[\s\S]*PI_TERMINAL_SHELL=powershell/,
		);
		expect(() => assertSupportedInShell("echo a\r\necho b", "cmd")).toThrow();
	});

	it("keeps single-line cmd commands and every other shell untouched", () => {
		expect(() => assertSupportedInShell("dir /b && echo DONE", "cmd")).not.toThrow();
		expect(() => assertSupportedInShell("echo a\necho b", "powershell")).not.toThrow();
		expect(() => assertSupportedInShell("echo a\necho b", "bash")).not.toThrow();
		expect(() => assertSupportedInShell("echo a\necho b", undefined)).not.toThrow();
	});
});

describe("shellDialect / shellGuideline", () => {
	it("names the active shell, dialect and pin source in the prompt guideline", () => {
		const note = shellGuideline("cmd.exe", { env: env(), probe: probe("cmd.exe"), detect: detect("pwsh.exe") });
		expect(note).toContain("cmd.exe session (cmd.exe)");
		expect(note).toContain("pinned via defaultShell");
		expect(note).toContain("one-shot");
	});

	it("describes the unpinned shell without a pin note", () => {
		const note = shellGuideline(null, { env: env(), detect: detect("pwsh.exe") });
		expect(note).toContain("PowerShell session (pwsh.exe)");
		expect(note).not.toContain("pinned via");
	});

	it("returns null instead of throwing when the pin is invalid", () => {
		expect(shellGuideline("gone", { env: env(), probe: probe(), detect: detect("pwsh.exe") })).toBeNull();
	});

	it("maps every dialect to a readable name", () => {
		expect(shellDialect("powershell")).toBe("PowerShell");
		expect(shellDialect("cmd")).toBe("cmd.exe");
		expect(shellDialect("bash")).toBe("bash");
	});
});
