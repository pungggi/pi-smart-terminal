/**
 * Shell pinning: exactly one shell per pi process.
 *
 * Why this exists (issue #10): the bash override has two execution paths —
 * the shared PTY session and a one-shot fallback for busy sessions. Each path
 * used to pick its own shell, so commands silently switched dialect
 * (PowerShell ↔ cmd.exe) mid-session and the agent burned turns re-diagnosing
 * a moving target. Pinning resolves the shell once and reuses it everywhere:
 *
 *   1. `PI_TERMINAL_SHELL` env var  — explicit, per-invocation pin
 *   2. config `defaultShell`        — per-machine pin (~/.pi/agent/smart-terminal.json)
 *   3. upstream auto-detect         — pwsh > powershell > cmd / $SHELL > bash > sh
 *
 * The first successful resolution is memoized for the lifetime of the process.
 * A later PATH change, session restart or cwd switch therefore cannot flip the
 * shell underneath a running session — determinism is the whole point.
 *
 * An invalid pin throws instead of silently falling back: a typo that quietly
 * reverts to auto-detection would reintroduce exactly the surprise this fixes.
 */

import { platform } from "node:os";

import { detectShell, getShellType, isAvailable } from "./core.js";

/** Env var that pins the shell (wins over config `defaultShell`). */
export const SHELL_PIN_ENV = "PI_TERMINAL_SHELL";
/** Resolved shell executable, exported for child processes / scripts. */
export const SHELL_ENV = "PI_SHELL";
/** Resolved dialect (`powershell` | `cmd` | `bash`), exported for scripts. */
export const SHELL_TYPE_ENV = "PI_SHELL_TYPE";

export type ShellType = "powershell" | "cmd" | "bash";
export type ShellSource = "env" | "config" | "detected";

export interface ResolvedShell {
	/** Executable name or absolute path, as handed to the PTY spawn. */
	shell: string;
	/** Dialect every execution path must use for this process. */
	shellType: ShellType;
	/** Where the decision came from (env pin / config / auto-detect). */
	source: ShellSource;
}

/** Injected probes so resolution is testable without touching the real PATH. */
export interface ResolveDeps {
	env?: Record<string, string | undefined>;
	probe?: (exe: string) => boolean;
	detect?: () => { shell: string; args: string[] };
}

/** Same extensions upstream's resolveUserShell() probes on Windows. */
const WINDOWS_SHELL_EXTENSIONS = [".exe", ".cmd", ".bat"];

/** Non-interactive args for the PowerShell family (mirrors upstream detect). */
export const POWERSHELL_ARGS = ["-NoLogo", "-NoProfile"];

/**
 * Validate a user-probed shell name/path. Throws an actionable error when it
 * does not resolve — a silent fallback would undo the pin.
 */
function validateShell(name: string, origin: string, probe: (exe: string) => boolean, detect: () => { shell: string; args: string[] }): string {
	if (probe(name)) return name;

	if (platform() === "win32" && !name.includes(".")) {
		for (const ext of WINDOWS_SHELL_EXTENSIONS) {
			const candidate = `${name}${ext}`;
			if (probe(candidate)) return candidate;
		}
	}

	let detected = "(unavailable)";
	try {
		detected = detect().shell;
	} catch {
		// keep the placeholder
	}

	const where = origin === "env" ? `${SHELL_PIN_ENV}="${name}"` : `defaultShell "${name}"`;
	throw new Error(
		`No such shell: ${where}. Pass an absolute path (e.g. C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe) ` +
			`or a name on PATH ("pwsh", "powershell", "cmd", "bash"), or remove the override to auto-detect ` +
			`(this machine would pick ${detected}).`,
	);
}

/**
 * Pick the shell once. Pure apart from `isAvailable`/`detectShell`, both
 * injectable for tests.
 */
export function resolveShell(configured: string | null | undefined, deps: ResolveDeps = {}): ResolvedShell {
	const env = deps.env ?? process.env;
	const probe = deps.probe ?? isAvailable;
	const detect = deps.detect ?? detectShell;

	const envPin = (env[SHELL_PIN_ENV] ?? "").trim();
	if (envPin) {
		const shell = validateShell(envPin, "env", probe, detect);
		return { shell, shellType: getShellType(shell), source: "env" };
	}

	const configPin = (configured ?? "").trim();
	if (configPin) {
		const shell = validateShell(configPin, "config", probe, detect);
		return { shell, shellType: getShellType(shell), source: "config" };
	}

	const detected = detect().shell;
	return { shell: detected, shellType: getShellType(detected), source: "detected" };
}

let cached: ResolvedShell | null = null;

/**
 * Memoized resolution for the whole process — the guarantee that every
 * execution path (agent session, terminal_start auto-detect, one-shot
 * fallback) agrees on one shell. First call wins; later calls reuse it.
 *
 * Side effect: exports `PI_SHELL` / `PI_SHELL_TYPE` into `process.env` so
 * child processes (fallback runs, `terminal_run`, user scripts) can branch on
 * the shell instead of guessing.
 */
export function getResolvedShell(configured: string | null | undefined, deps: ResolveDeps = {}): ResolvedShell {
	if (cached) return cached;
	const resolved = resolveShell(configured, deps);
	cached = resolved;
	process.env[SHELL_ENV] = resolved.shell;
	process.env[SHELL_TYPE_ENV] = resolved.shellType;
	return resolved;
}

/** Drop the memoized pin (tests; a real pi process never needs this). */
export function resetResolvedShell(): void {
	cached = null;
}

/**
 * Value to hand to `SessionManager.create({ shell })`.
 *
 * Auto-detected shells are passed as `undefined` on purpose: upstream then
 * runs its own detection and supplies `-NoLogo -NoProfile` itself. Only an
 * explicit pin is forwarded (the SessionClass shim restores those flags, see
 * runtime.ts).
 */
export function sessionShell(resolved: ResolvedShell): string | undefined {
	return resolved.source === "detected" ? undefined : resolved.shell;
}

/** Args a pinned PowerShell-family shell must keep (profile = machine noise). */
export function shellArgsFor(shell: string): string[] {
	return getShellType(shell) === "powershell" ? [...POWERSHELL_ARGS] : [];
}

/** Human name of the dialect, for prompts and notices. */
export function shellDialect(shellType: ShellType): string {
	switch (shellType) {
		case "powershell":
			return "PowerShell";
		case "cmd":
			return "cmd.exe";
		default:
			return "bash";
	}
}

/** One representative command per dialect (keeps prompt guidance concrete). */
function shellExample(shellType: ShellType): string {
	switch (shellType) {
		case "powershell":
			return "Get-ChildItem, Get-Content -Tail, | Select-Object";
		case "cmd":
			return "dir, type, findstr, &";
		default:
			return "ls, head, grep, &&";
	}
}

const MULTI_LINE = /[\r\n]/;

/**
 * Fail fast on payloads a shell cannot carry through the PTY.
 *
 * cmd.exe has no byte-exact encoding (PowerShell gets a base64 `iex` one-liner),
 * and a multi-line script typed line by line lets unclosed quotes/parens wedge
 * the prompt at `More?`. Rejecting with the workaround is cheaper than a hung
 * session: same policy as the here-string/heredoc guard in terminal_exec.
 */
export function assertSupportedInShell(command: string, shellType: string | undefined): void {
	if (shellType !== "cmd" || !MULTI_LINE.test(command)) return;
	throw new Error(
		"Multi-line commands are rejected in a cmd.exe session: the PTY feeds input line by line, so quotes and " +
			"parentheses that span lines never close and the prompt wedges at `More?`.\n" +
			"Fix: run one command per call, or write the script to a file (write tool / terminal_write_file) and run it " +
			"(`cmd /c path\\to\\script.cmd`), or pin a shell that encodes multi-line payloads: " +
			`${SHELL_PIN_ENV}=powershell (or "defaultShell" in ~/.pi/agent/smart-terminal.json).`,
	);
}

/**
 * Prompt guideline naming the active shell, or null when the pin is invalid
 * (the error then surfaces on the first bash call instead of at startup).
 */
export function shellGuideline(
	configured: string | null | undefined,
	deps: ResolveDeps = {},
): string | null {
	try {
		const { shell, shellType, source } = getResolvedShell(configured, deps);
		const dialect = shellDialect(shellType);
		const pinned =
			source === "detected" ? "" : ` — pinned via ${source === "env" ? SHELL_PIN_ENV : "defaultShell"}`;
		return (
			`The bash tool runs in one persistent ${dialect} session (${shell})${pinned}: ` +
			`use ${dialect} syntax (e.g. ${shellExample(shellType)}). ` +
			`If the shared session is busy, the same ${dialect} runs the command one-shot and a trailing notice says so: ` +
			`cd and env from the shared session do not apply there.`
		);
	} catch {
		return null;
	}
}
