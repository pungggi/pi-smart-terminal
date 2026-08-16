/**
 * Adapter for the smart-terminal-mcp core.
 *
 * All upstream imports are isolated in this file so that a future `exports`
 * map in smart-terminal-mcp (or moving the core modules into this package)
 * only requires changes here.
 */

export type {
	PtySession,
	ExecResult,
	ReadResult,
	WaitResult,
	WatchResult,
	SessionInfo,
	HistoryLinesResult,
	HistoryTextResult,
} from "smart-terminal-mcp/src/pty-session.js";

export { SessionManager } from "smart-terminal-mcp/src/session-manager.js";

export { runCommand, DEFAULT_TIMEOUT_MS, DEFAULT_MAX_OUTPUT_BYTES } from "smart-terminal-mcp/src/command-runner.js";

export { paginateOutput, DEFAULT_PAGE_SIZE } from "smart-terminal-mcp/src/pager.js";

export { summarizeCommandOutput, normalizeCommandName } from "smart-terminal-mcp/src/command-parsers.js";

export { execWithRetry, execAndDiff } from "smart-terminal-mcp/src/smart-tools.js";

export {
	DEFAULT_EXEC_MAX_LINES,
	DEFAULT_READ_MAX_LINES,
	DEFAULT_HISTORY_LIMIT,
	SUPPORTED_KEYS,
} from "smart-terminal-mcp/src/pty-session.js";
