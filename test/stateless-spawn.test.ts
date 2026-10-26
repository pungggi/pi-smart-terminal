import { describe, expect, it } from "vitest";

import { runCommand } from "../src/core.js";
import { statelessPlan } from "../src/bash-backend.js";
import type { ResolvedShell } from "../src/shell.js";

/**
 * REAL one-shot spawns: verifies the fallback plan executes in the pinned
 * shell with correct exit-code propagation (the property pi's bash tool
 * relies on). Skipped off Windows — the whole point is the PowerShell/cmd duality.
 */
const win = process.platform === "win32";
const ps: ResolvedShell = { shell: "powershell.exe", shellType: "powershell", source: "env" };
const cmd: ResolvedShell = { shell: "cmd.exe", shellType: "cmd", source: "env" };

describe.runIf(win)("stateless plan against real processes", () => {
	it("PowerShell one-shot runs and reports the dialect", async () => {
		const plan = statelessPlan("Write-Output \"PS:$($PSVersionTable.PSEdition)\"", ps);
		const result = await runCommand({ cmd: plan.cmd, args: plan.args, shell: plan.shell, parse: false, timeout: 60000 });
		expect(result.exitCode).toBe(0);
		// Desktop (Windows PowerShell 5.1) or Core (pwsh) — both must announce.
		expect(result.stdout.raw).toMatch(/PS:(Core|Desktop)/);
	});

	it("PowerShell one-shot propagates a failing exit code (not the default 0)", async () => {
		const plan = statelessPlan("Get-Item C:\\definitely-not-here-$pid", ps);
		const result = await runCommand({ cmd: plan.cmd, args: plan.args, shell: plan.shell, parse: false, timeout: 60000 });
		expect(result.exitCode).not.toBe(0);
	});

	it("PowerShell one-shot keeps non-ASCII output intact", async () => {
		const plan = statelessPlan("Write-Output 'héllo — ±30%'", ps);
		const result = await runCommand({ cmd: plan.cmd, args: plan.args, shell: plan.shell, parse: false, timeout: 60000 });
		expect(result.stdout.raw).toContain("héllo — ±30%");
	});

	it("cmd one-shot runs the same command dialect", async () => {
		const plan = statelessPlan("echo CMD-OK", cmd);
		const result = await runCommand({ cmd: plan.cmd, args: plan.args, shell: plan.shell, parse: false, timeout: 60000 });
		expect(result.exitCode).toBe(0);
		expect(result.stdout.raw).toContain("CMD-OK");
	});

	it("cmd one-shot propagates a failing exit code", async () => {
		const plan = statelessPlan("cmd /c exit 7", cmd);
		const result = await runCommand({ cmd: plan.cmd, args: plan.args, shell: plan.shell, parse: false, timeout: 60000 });
		expect(result.exitCode).toBe(7);
	});
});
