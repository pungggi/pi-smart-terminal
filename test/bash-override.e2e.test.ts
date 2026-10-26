import { afterAll, describe, expect, it } from "vitest";

import { createPtyBashOperations } from "../src/bash-backend.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { destroyRuntime, runtime } from "../src/runtime.js";
import { getResolvedShell, resetResolvedShell } from "../src/shell.js";

/**
 * End-to-end proof for issue #10: a bash call issued while the shared session
 * is busy must degrade to a one-shot run in the SAME shell, visibly, instead
 * of silently dropping to cmd.exe (Node's platform shell).
 *
 * Spawns real PTYs, so it is Windows/dev-machine only and slower than the
 * unit suite. Timeout is generous: the first call pays the shell banner wait.
 */
const win = process.platform === "win32";

function collect() {
	const chunks: string[] = [];
	return { onData: (b: Buffer) => chunks.push(b.toString("utf8")), text: () => chunks.join("") };
}

/** Wait until the shared session actually holds the busy lock (banner wait varies). */
async function waitForBusy(timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const id = runtime.agentSessionId;
		if (id) {
			try {
				if (runtime.manager?.get(id).busy) return true;
			} catch {
				// session gone — keep polling until the deadline
			}
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	return false;
}

describe.runIf(win)("bash override degradation (issue #10)", () => {
	afterAll(() => {
		destroyRuntime();
		resetResolvedShell();
	});

	it(
		"busy-session fallback runs the pinned shell and announces itself",
		{ timeout: 60000 },
		async () => {
			const operations = createPtyBashOperations(DEFAULT_CONFIG);
			const pinned = getResolvedShell(DEFAULT_CONFIG.defaultShell);

			// 1. Normal path: creates the shared agent session (waits for banner).
			const first = collect();
			const slow = operations.exec("Start-Sleep -Seconds 4; Write-Output 'SLOW-DONE'", process.cwd(), {
				onData: first.onData,
				signal: undefined as unknown as AbortSignal,
				timeout: 60,
			});
			// Never leave an unhandled rejection if an assertion below fails first.
			slow.catch(() => undefined);

			// Wait for the first call to take the busy lock (banner wait varies).
			const busy = await waitForBusy(15000);
			expect(busy).toBe(true);
			expect(runtime.agentSessionId).not.toBeNull();

			// 2. Second call while the session is busy → one-shot fallback.
			const second = collect();
			const fallback = await operations.exec("Write-Output 'FALLBACK-OK'", process.cwd(), {
				onData: second.onData,
				signal: undefined as unknown as AbortSignal,
				timeout: 60,
			});

			const output = second.text();
			// The degradation is visible, not silent…
			expect(output).toContain("[smart-terminal] shared session busy:");
			expect(output).toContain("do not apply here");
			// …and it ran in the pinned dialect, never in a foreign one.
			expect(output).toContain("FALLBACK-OK");
			const dialect = pinned.shellType === "powershell" ? "PowerShell" : pinned.shellType === "cmd" ? "cmd.exe" : "bash";
			expect(output).toContain(dialect);
			expect(fallback.exitCode).toBe(0);

			await slow;
			expect(first.text()).toContain("SLOW-DONE");
		},
	);
});
