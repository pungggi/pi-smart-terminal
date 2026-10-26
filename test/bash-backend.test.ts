import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	createPtyBashOperations,
	needsSingleLine,
	statelessPlan,
	toPowershellEncodedCommand,
	toPowershellSingleLine,
	toPowershellStatelessScript,
} from "../src/bash-backend.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { SHELL_PIN_ENV, resetResolvedShell } from "../src/shell.js";

describe("needsSingleLine", () => {
	it("flags multi-line commands only for line-continuation-hostile shells", () => {
		expect(needsSingleLine("node -e \"\nfoo\n\"", "powershell")).toBe(true);
		expect(needsSingleLine("node -e \"\nfoo\n\"", "cmd")).toBe(true);
		expect(needsSingleLine("node -e \"\nfoo\n\"", "bash")).toBe(false);
		expect(needsSingleLine("single line", "powershell")).toBe(false);
		expect(needsSingleLine("single line", undefined)).toBe(false);
		expect(needsSingleLine("has\rcr", "powershell")).toBe(true);
	});
});

describe("toPowershellSingleLine", () => {
	it("produces a single-line iex/base64 wrapper decoding to the exact payload", () => {
		const cmd = "node -e \"\nconst NL='\\r\\n';\nconsole.log('x');\n\"";
		const wrapped = toPowershellSingleLine(cmd);
		expect(wrapped).not.toMatch(/[\r\n]/);
		expect(wrapped).toMatch(/^iex \(\[Text\.Encoding\]::UTF8\.GetString\(\[Convert\]::FromBase64String\('[A-Za-z0-9+/=]+'\)\)\)$/);

		const b64 = wrapped.match(/FromBase64String\('([^']+)'/)![1];
		expect(Buffer.from(b64, "base64").toString("utf8")).toBe(cmd);
	});

	it("keeps non-ASCII payloads byte-exact", () => {
		const cmd = "echo 'héllo — ±30% → done'";
		const b64 = toPowershellSingleLine(cmd).match(/FromBase64String\('([^']+)'/)![1];
		expect(Buffer.from(b64, "base64").toString("utf8")).toBe(cmd);
	});
});

describe("stateless fallback plan (same shell as the session, issue #10)", () => {
	const resolved = (shellType: "powershell" | "cmd" | "bash", shell: string) => ({
		shell,
		shellType,
		source: "env" as const,
	});

	it("runs PowerShell one-shots via -EncodedCommand with byte-exact payload", () => {
		const plan = statelessPlan("Get-Content x.log -Tail 25", resolved("powershell", "pwsh.exe"));
		expect(plan).toMatchObject({ cmd: "pwsh.exe", shell: false });
		expect(plan.args.slice(0, 4)).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand"]);

		const script = Buffer.from(plan.args[4], "base64").toString("utf16le");
		expect(script).toContain("Get-Content x.log -Tail 25");
		// exit code must be derived, not powershell's default 0
		expect(script).toContain("exit $__rc");
	});

	it("keeps cmd one-shots on cmd.exe (Node's platform shell = the pin)", () => {
		const plan = statelessPlan("dir /b & echo DONE", resolved("cmd", "cmd.exe"));
		expect(plan).toEqual({ cmd: "dir /b & echo DONE", args: [], shell: true });
	});

	it("runs bash one-shots with -c, no shell re-parse layer", () => {
		const plan = statelessPlan("head -n 5 f.txt", resolved("bash", "/bin/bash"));
		expect(plan).toEqual({ cmd: "/bin/bash", args: ["-c", "head -n 5 f.txt"], shell: false });
	});

	it("propagates a full multi-line script byte-exact through the encoding", () => {
		const cmd = "if (Test-Path x) {\n  Get-ChildItem\n}";
		const plan = statelessPlan(cmd, resolved("powershell", "powershell.exe"));
		const script = Buffer.from(plan.args[4], "base64").toString("utf16le");
		expect(script).toContain(cmd);
	});
});

describe("toPowershellEncodedCommand / toPowershellStatelessScript", () => {
	it("encodes as UTF-16LE base64, the -EncodedCommand wire format", () => {
		const script = "Write-Output 'héllo'";
		const encoded = toPowershellEncodedCommand(script);
		expect(Buffer.from(encoded, "base64").toString("utf16le")).toBe(script);
	});

	it("clears stale $LASTEXITCODE, pins UTF-8 output and exits with the derived code", () => {
		const script = toPowershellStatelessScript("Get-ChildItem");
		expect(script.split("\n")[0]).toContain("UTF8Encoding");
		expect(script).toContain("$global:LASTEXITCODE = $null");
		expect(script).toContain("Get-ChildItem");
		expect(script.trimEnd().endsWith("exit $__rc")).toBe(true);
	});
});

describe("cmd multi-line rejection at the bash backend", () => {
	const originalPin = process.env[SHELL_PIN_ENV];

	beforeEach(() => {
		resetResolvedShell();
		process.env[SHELL_PIN_ENV] = "cmd";
	});
	afterEach(() => {
		resetResolvedShell();
		if (originalPin === undefined) delete process.env[SHELL_PIN_ENV];
		else process.env[SHELL_PIN_ENV] = originalPin;
	});

	it.runIf(process.platform === "win32")("fails fast before any PTY is spawned, with the workaround", async () => {
		const operations = createPtyBashOperations(DEFAULT_CONFIG);
		await expect(
			operations.exec("echo a\necho b", process.cwd(), {
				onData: () => {},
				signal: undefined as unknown as AbortSignal,
				timeout: 30,
			}),
		).rejects.toThrowError(/Multi-line commands are rejected in a cmd\.exe session[\s\S]*PI_TERMINAL_SHELL=powershell/);
	});
});
