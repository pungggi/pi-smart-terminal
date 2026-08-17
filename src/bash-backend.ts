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

			// Fast path: the shared persistent session.
			let session = null;
			try {
				session = await getOrCreateAgentSession({ cwd, shell: config.defaultShell });
			} catch {
				session = null; // e.g. MAX_SESSIONS reached → stateless fallback below
			}

			if (session && !session.busy) {
				const payload = needsSingleLine(command, session.shellType)
					? toPowershellSingleLine(command)
					: command;
				return execInSession(session, payload, { onData, signal, timeoutSecs, timeoutMs });
			}

			// Session busy (background command / parallel bash call) or unavailable:
			// degrade to a stateless one-shot so the call still succeeds.
			return execStateless(command, cwd, { onData, signal, timeoutSecs, timeoutMs });
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
	ctx: ExecContext,
): Promise<{ exitCode: number | null }> {
	const result = await runCommand({
		cmd: command,
		args: [],
		cwd,
		timeout: ctx.timeoutMs,
		shell: true,
		parse: false,
	});

	if (ctx.signal?.aborted) throw new Error("aborted");
	if (result.timedOut) throw new Error(`timeout:${Math.max(1, Math.round(ctx.timeoutMs / 1000))}`);

	const text = [result.stdout.raw, result.stderr.raw].filter((s) => s.trim()).join("\n");
	if (text.trim()) ctx.onData(Buffer.from(text + "\n"));

	return { exitCode: result.exitCode };
}
