/**
 * Guards for restricted tools. Mirrors the read-only allowlist from
 * smart-terminal-mcp's terminal_run_paged.
 */

import { normalizeCommandName } from "./core.js";

const READ_ONLY_PAGED_COMMANDS = new Set(["tasklist", "where", "which"]);
const READ_ONLY_GIT_SUBCOMMANDS = new Set([
	"branch",
	"diff",
	"log",
	"ls-files",
	"remote",
	"rev-parse",
	"status",
]);

/** Throw unless the command is in the read-only allowlist for paged runs. */
export function assertPagedCommandIsReadOnly(cmd: string, args: string[] = []): void {
	const commandName = normalizeCommandName(cmd);
	if (READ_ONLY_PAGED_COMMANDS.has(commandName)) return;

	if (commandName === "git") {
		const subcommand = args[0]?.toLowerCase();
		if (READ_ONLY_GIT_SUBCOMMANDS.has(subcommand)) return;
	}

	throw new Error(
		"terminal_run_paged only supports read-only commands: git (branch, diff, log, ls-files, remote, rev-parse, status), tasklist, where, which.",
	);
}
