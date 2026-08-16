/**
 * Type declarations for the smart-terminal-mcp core modules.
 *
 * The upstream package is plain ESM JavaScript without bundled .d.ts files.
 * These declarations cover only the surface pi-smart-terminal consumes.
 * Shapes mirror src/*.js in smart-terminal-mcp v1.2.x.
 */

declare module "smart-terminal-mcp/src/pty-session.js" {
	export interface ExecResult {
		output: string;
		exitCode: number | null;
		cwd: string | null;
		timedOut: boolean;
		quietExited?: boolean;
		hint?: string;
	}

	export interface ReadResult {
		output: string;
		timedOut: boolean;
		position: number;
		truncated?: boolean;
	}

	export interface WaitResult {
		output: string;
		matched: boolean;
		timedOut: boolean;
	}

	export interface WatchResult {
		reason: "trigger" | "quiet" | "timeout" | "exit";
		triggerId?: string;
		matchedLine?: string;
		context?: string[];
		position: number;
		timedOut: boolean;
	}

	export interface SessionInfo {
		id: string;
		name: string | null;
		cwd: string;
		alive: boolean;
		busy: boolean;
		shell?: string;
		shellType?: string;
		cols?: number;
		rows?: number;
		createdAt?: string;
		lastActivity?: string;
		idleSeconds?: number;
	}

	export interface HistoryLinesResult {
		lines: string[];
		totalLines: number;
		returnedFrom: number;
		returnedTo: number;
	}

	export interface HistoryTextResult {
		text: string;
		totalLines: number;
		returnedFrom: number;
		returnedTo: number;
	}

	export interface ExecOptions {
		command: string;
		timeout?: number;
		maxLines?: number;
		quietExitMs?: number;
		minOutputBytes?: number;
		sendNotification?: (notification: unknown) => void;
		progressToken?: string | number;
	}

	export class PtySession {
		id: string;
		shell: string;
		shellType: string;
		name: string | null;
		cols: number;
		rows: number;
		cwd: string;
		alive: boolean;
		busy: boolean;
		constructor(opts: {
			id: string;
			shell: string;
			shellArgs: string[];
			cols: number;
			rows: number;
			cwd: string;
			name?: string;
			env?: Record<string, string>;
		});
		waitForBanner(): Promise<string>;
		exec(opts: ExecOptions): Promise<ExecResult>;
		write(data: string): void;
		sendKey(key: string): void;
		read(opts?: {
			timeout?: number;
			idleTimeout?: number;
			maxLines?: number;
			since?: number;
		}): Promise<ReadResult>;
		waitForPattern(opts: {
			pattern: string;
			timeout?: number;
			returnMode?: "tail" | "full" | "match-only";
			tailLines?: number;
		}): Promise<WaitResult>;
		watch(opts: {
			triggers: Array<{ id: string; pattern: string; isRegex?: boolean; cooldownMs?: number }>;
			timeout?: number;
			quietExitMs?: number;
			contextLines?: number;
			since?: number;
		}): Promise<WatchResult>;
		resize(cols: number, rows: number): void;
		kill(signal?: string): void;
		getInfo(opts?: { verbose?: boolean }): SessionInfo;
		getHistory(opts: { offset?: number; limit?: number; format: "lines" }): HistoryLinesResult;
		getHistory(opts: { offset?: number; limit?: number; format: "text" }): HistoryTextResult;
		getHistory(opts?: {
			offset?: number;
			limit?: number;
			format?: "lines" | "text";
		}): HistoryLinesResult | HistoryTextResult;
	}

	export const DEFAULT_EXEC_MAX_LINES: number;
	export const DEFAULT_READ_MAX_LINES: number;
	export const DEFAULT_HISTORY_LIMIT: number;
	export const SUPPORTED_KEYS: string[];
}

declare module "smart-terminal-mcp/src/session-manager.js" {
	import type { PtySession, SessionInfo } from "smart-terminal-mcp/src/pty-session.js";

	export class SessionManager {
		constructor(opts?: { SessionClass?: new (opts: never) => PtySession });
		create(opts?: {
			shell?: string;
			cols?: number;
			rows?: number;
			cwd?: string;
			name?: string;
			env?: Record<string, string>;
		}): Promise<PtySession>;
		get(id: string): PtySession;
		stop(id: string): void;
		list(opts?: { verbose?: boolean }): SessionInfo[];
		destroyAll(): void;
	}

	export function resolveSessionCwd(cwd?: string): Promise<string>;
}

declare module "smart-terminal-mcp/src/command-runner.js" {
	export interface RunCommandResult {
		cmd: string;
		args: string[];
		exitCode: number | null;
		timedOut: boolean;
		killed: boolean;
		durationMs: number;
		stdout: { raw: string; parsed: unknown };
		stderr: { raw: string; parsed: unknown };
		parsing?: { parser: string } | null;
		summary?: string | null;
		success?: { ok: boolean; reason: string };
	}

	export function runCommand(opts: {
		cmd: string;
		args?: string[];
		cwd?: string;
		timeout?: number;
		maxOutputBytes?: number;
		parse?: boolean;
		parseOnly?: boolean;
		summary?: boolean;
		successExitCode?: number | null;
		successFile?: string;
		successFilePattern?: string;
		shell?: boolean;
	}): Promise<RunCommandResult>;

	export const DEFAULT_TIMEOUT_MS: number;
	export const DEFAULT_MAX_OUTPUT_BYTES: number;
}

declare module "smart-terminal-mcp/src/pager.js" {
	export interface PaginationResult {
		page: number;
		pageSize: number;
		totalLines: number;
		pageText: string;
		hasNext: boolean;
	}

	export function paginateOutput(
		text: string,
		opts: { page?: number; pageSize?: number },
	): PaginationResult;

	export const DEFAULT_PAGE_SIZE: number;
}

declare module "smart-terminal-mcp/src/command-parsers.js" {
	export function summarizeCommandOutput(opts: {
		cmd: string;
		args: string[];
		parsed: unknown;
	}): string | null;

	export function normalizeCommandName(cmd: string): string;
}

declare module "smart-terminal-mcp/src/smart-tools.js" {
	import type { PtySession, ExecResult } from "smart-terminal-mcp/src/pty-session.js";

	export interface RetryResult extends ExecResult {
		attempts: number;
		retryLog: string[];
	}

	export interface DiffResult {
		commandA: string;
		commandB: string;
		diff: string;
		changed: boolean;
		stats: { added: number; removed: number };
	}

	export function execWithRetry(
		session: PtySession,
		opts: {
			command: string;
			maxRetries?: number;
			backoff?: "fixed" | "exponential" | "linear";
			delayMs?: number;
			timeout?: number;
			maxLines?: number;
			successExitCode?: number | null;
			successPattern?: string | null;
		},
	): Promise<RetryResult>;

	export function execAndDiff(
		session: PtySession,
		opts: {
			commandA: string;
			commandB: string;
			timeout?: number;
			maxLines?: number;
			contextLines?: number;
		},
	): Promise<DiffResult>;
}
