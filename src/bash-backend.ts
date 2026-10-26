/**
 * PTY-backed BashOperations for pi's bash tool.
 *
 * Implements the pluggable execution backend contract from
 * @earendil-works/pi-coding-agent so the built-in bash tool keeps its
 * native rendering, truncation and timeout semantics — while every
 * command runs in ONE persistent PTY session (shared with the
 * terminal_* tools and, if enabled, user `!` commands).
 *
 * Error-message protocol expected by pi's bash tool:
 *   - throw Error("aborted")           → "Command aborted"
 *   - throw Error("timeout:<seconds>") → "Command timed out after <s> seconds"
 */

import type { BashOperations } from "@earendil-works/pi-coding-agent";

import { runCommand } from "./core.js";
import { getOrCreateAgentSession } from "./runtime.js";
import {
	assertSupportedInShell,
	getResolvedShell,
	sessionShell,
	shellDialect,
	type ResolvedShell,
} from "./shell.js";
import type { SmartTerminalConfig } from "./config.js";

/** Max lines requested from session.exec; pi's accumulator truncates further. */
const EXEC_MAX_LINES = 10000;

/**
 * PSReadLine mishandles fast multi-line writes: each newline acts as Enter,
 * the paste lands out of order and the closing quote never balances — the
 * shell wedges at a `>>` continuation prompt forever. Base64 keeps the
 * payload byte-exact on a single line.
 */
export function toPowershellSingleLine(command: string): string {
	const b64 = Buffer.from(command, "utf8").toString("base64");
	return `iex ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}')))`;
}

/** True when a command needs the powershell single-line treatment. */
export function needsSingleLine(command: string, shellType: string | undefined): boolean {
	return (shellType === "powershell" || shellType === "cmd") && /[\r\n]/.test(command);
}

/**
 * Byte-exact single-line encoding for `-EncodedCommand`: base64 over UTF-16LE,
 * which is the wire format PowerShell expects. No quoting rules can mangle it,
 * so it is safe for arbitrary payloads in a one-shot (non-PTY) spawn.
 */
export function toPowershellEncodedCommand(script: string): string {
	return Buffer.from(script, "utf16le").toString("base64");
}

/**
 * One-shot PowerShell script: runs the command and exits with its code.
 *
 * `powershell -Command` reports 0 unless the script calls `exit`, so a failing
 * command would look successful to pi's bash tool. This mirrors the session
 * wrapper in smart-terminal-mcp: derive the code from `$?` / `$LASTEXITCODE`
 * exactly the way the PTY path does, keeping both paths' exit semantics equal.
 */
/**
 * One-shot PowerShell script: runs the command and exits with its code.
 *
 * `powershell -Command` reports 0 unless the script calls `exit`, so a failing
 * command would look successful to pi's bash tool. This mirrors the session
 * wrapper in smart-terminal-mcp: derive the code from `$?` / `$LASTEXITCODE`
 * exactly the way the PTY path does, keeping both paths' exit semantics equal.
 *
 * The first line forces UTF-8 for redirected stdout: Windows PowerShell 5.1
 * writes piped output in the OEM console codepage, which mangles non-ASCII
 * before the bytes ever reach the agent (pwsh 7 already defaults to UTF-8;
 * the assignment is a harmless no-op there). Guarded because the setter needs
 * a console handle, which a windowsHide spawn does not have on some hosts.
 */
export function toPowershellStatelessScript(command: string): string {
	return [
		"try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch {}",
		"$global:LASTEXITCODE = $null",
		command,
		"$__rc = if ($?) { if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } else { 0 } } " +
			"else { if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } else { 1 } }",
		"exit $__rc",
	].join("\n");
}

export interface StatelessPlan {
	cmd: string;
	args: string[];
	shell: boolean;
}

/**
 * Build the one-shot spawn for the *pinned* shell — the whole point of issue
 * #10: the fallback must never be a different dialect than the session.
 *
 *  - powershell: `-EncodedCommand` (byte-exact, exit code propagated)
 *  - cmd: `shell: true` → %ComSpec%, i.e. cmd.exe itself — identical to the pin
 *  - bash/zsh/fish: `-c <command>` (argv is passed straight to the shell)
 */
export function statelessPlan(command: string, resolved: ResolvedShell): StatelessPlan {
	switch (resolved.shellType) {
		case "powershell":
			return {
				cmd: resolved.shell,
				args: [
					"-NoLogo",
					"-NoProfile",
					"-NonInteractive",
					"-EncodedCommand",
					toPowershellEncodedCommand(toPowershellStatelessScript(command)),
				],
				shell: false,
			};
		case "cmd":
			return { cmd: command, args: [], shell: true };
		default:
			return { cmd: resolved.shell, args: ["-c", command], shell: false };
	}
}

export function createPtyBashOperations(config: SmartTerminalConfig): BashOperations {
	return {
		exec: async (command, cwd, { onData, signal, timeout }) => {
			const timeoutSecs = timeout;
			// Hard cap: bashTimeoutMs bounds EVERY call, including model-passed
			// timeouts. Models confuse ms/seconds ("30000" for 30 s) — without
			// the clamp that becomes an 8-hour wedge.
			const timeoutMs = Math.min(
				timeoutSecs != null ? timeoutSecs * 1000 : config.bashTimeoutMs,
				config.bashTimeoutMs,
			);

			// Resolve the process-wide shell pin (lazy on purpose: an invalid pin
			// becomes a tool error here, with the fix, instead of a startup crash).
			const resolved = getResolvedShell(config.defaultShell);

			// Reject payloads the pinned shell cannot carry BEFORE any spawn: fail
			// fast and cheap (no PTY wait for a command that cannot succeed).
			assertSupportedInShell(command, resolved.shellType);

			// Fast path: the shared persistent session.
			let session = null;
			try {
				session = await getOrCreateAgentSession({ cwd, shell: sessionShell(resolved) });
			} catch {
				session = null; // e.g. MAX_SESSIONS reached → stateless fallback below
			}

			// Belt and braces: the live session's shell must match the pin (memoized
			// resolution guarantees it, but never let a divergent session run a
			// payload the guard already rejected).
			if (session) assertSupportedInShell(command, session.shellType);

			if (session && !session.busy) {
				const payload = needsSingleLine(command, session.shellType)
					? toPowershellSingleLine(command)
					: command;
				return execInSession(session, payload, { onData, signal, timeoutSecs, timeoutMs });
			}

			// Session busy (background command / parallel bash call) or unavailable:
			// degrade to a stateless one-shot so the call still succeeds — in the
			// SAME shell, with a visible notice instead of a silent dialect switch.
			const reason = session ? "busy" : "unavailable";
			return execStateless(command, cwd, resolved, { onData, signal, timeoutSecs, timeoutMs }, reason);
		},
	};
}

interface ExecContext {
	onData: (data: Buffer) => void;
	signal?: AbortSignal;
	timeoutSecs: number | undefined;
	timeoutMs: number;
}

async function execInSession(
	session: NonNullable<Awaited<ReturnType<typeof getOrCreateAgentSession>>>,
	command: string,
	ctx: ExecContext,
): Promise<{ exitCode: number | null }> {
	const onAbort = () => {
		try {
			session.sendKey("ctrl+c");
		} catch {
			// best-effort interrupt
		}
	};
	ctx.signal?.addEventListener("abort", onAbort, { once: true });

	try {
		const result = await session.exec({
			command,
			timeout: ctx.timeoutMs,
			maxLines: EXEC_MAX_LINES,
		});

		if (ctx.signal?.aborted) throw new Error("aborted");
		if (result.timedOut) {
			// Surface partial output before reporting the timeout, matching
			// the MCP behavior of "still running in the background".
			if (result.output) ctx.onData(Buffer.from(result.output + "\n"));
			throw new Error(`timeout:${Math.max(1, Math.round(ctx.timeoutMs / 1000))}`);
		}

		const text = [result.output, result.quietExited ? result.hint : null].filter(Boolean).join("\n\n");
		if (text.trim()) ctx.onData(Buffer.from(text + "\n"));

		return { exitCode: result.exitCode };
	} finally {
		ctx.signal?.removeEventListener("abort", onAbort);
	}
}

async function execStateless(
	command: string,
	cwd: string,
	resolved: ResolvedShell,
	ctx: ExecContext,
	reason: "busy" | "unavailable",
): Promise<{ exitCode: number | null }> {
	const plan = statelessPlan(command, resolved);
	const result = await runCommand({
		cmd: plan.cmd,
		args: plan.args,
		cwd,
		timeout: ctx.timeoutMs,
		shell: plan.shell,
		parse: false,
	});

	if (ctx.signal?.aborted) throw new Error("aborted");
	if (result.timedOut) throw new Error(`timeout:${Math.max(1, Math.round(ctx.timeoutMs / 1000))}`);

	// Make the degradation visible: same shell as the session, but a fresh
	// process — cwd/env persistence is gone for this call. Silence here is what
	// made agents re-diagnose a "moving target" (issue #10).
	const notice =
		`[smart-terminal] shared session ${reason}: ran one-shot in ${shellDialect(resolved.shellType)} ` +
		`(${resolved.shell}). Stateless, so cd and env from the shared session do not apply here.`;

	const text = [result.stdout.raw, result.stderr.raw, notice]
		.filter((s) => s.trim())
		.join("\n");
	if (text.trim()) ctx.onData(Buffer.from(text + "\n"));

	return { exitCode: result.exitCode };
}
