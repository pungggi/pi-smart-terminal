/**
 * Lazy runtime state shared by the bash override, tools, overlay and footer.
 *
 * The SessionManager is only constructed on first use (never in the
 * extension factory) so pi invocations without a session never spawn
 * timers or PTYs.
 */

import { PtySession, SessionManager, type PtySessionOptions } from "./core.js";
import { shellArgsFor } from "./shell.js";

export { SessionManager };
export type { PtySession };

/**
 * Upstream `SessionManager.create()` passes `shellArgs: []` whenever an
 * explicit shell is given, which would drop `-NoLogo -NoProfile` from a
 * pinned PowerShell and let the user's profile (aliases, prompt, PSReadLine)
 * change command semantics — the opposite of the determinism a pin promises.
 *
 * This SessionClass restores the non-interactive flags for the PowerShell
 * family. For every other shell, and for auto-detected sessions (upstream
 * already supplies the flags there), it is a no-op.
 */
class PinnedPtySession extends PtySession {
	constructor(opts: PtySessionOptions) {
		super({ ...opts, shellArgs: opts.shellArgs?.length ? opts.shellArgs : shellArgsFor(opts.shell) });
	}
}

/** The one SessionManager for this process: pinned-args session class, lazily built. */
export function ensureManager(): SessionManager {
	runtime.manager ??= new SessionManager({ SessionClass: PinnedPtySession });
	return runtime.manager;
}

export interface SmartTerminalRuntime {
	manager: SessionManager | null;
	/** Session id of the shared "agent shell" used by the bash override. */
	agentSessionId: string | null;
}

export const runtime: SmartTerminalRuntime = {
	manager: null,
	agentSessionId: null,
};

export interface EnsureSessionOptions {
	cwd: string;
	shell?: string | null;
}

/**
 * Get (or lazily create) the shared agent session used by the bash override
 * and opt-in user_bash routing.
 *
 * - Creates the session on first call and waits for the shell banner.
 * - Re-creates it in `cwd` if it died (e.g. shell exited).
 * - The per-call `cwd` is only used for (re-)creation: afterwards the
 *   session's own cwd is authoritative, so `cd` persistence works.
 */
export async function getOrCreateAgentSession(opts: EnsureSessionOptions): Promise<PtySession> {
	const manager = ensureManager();

	let session: PtySession | null = null;
	if (runtime.agentSessionId) {
		try {
			const existing = manager.get(runtime.agentSessionId);
			if (existing.alive) session = existing;
		} catch {
			session = null;
		}
	}

	if (!session) {
		session = await manager.create({
			cwd: opts.cwd,
			shell: opts.shell ?? undefined,
			name: "agent",
		});
		runtime.agentSessionId = session.id;
		await session.waitForBanner();
	}

	return session;
}

/** Drop the agent-session reference (e.g. after terminal_stop). */
export function clearAgentSession(sessionId: string): void {
	if (runtime.agentSessionId === sessionId) {
		runtime.agentSessionId = null;
	}
}

/** Destroy all sessions and release the manager. Safe to call repeatedly. */
export function destroyRuntime(): void {
	runtime.manager?.destroyAll();
	runtime.manager = null;
	runtime.agentSessionId = null;
}
