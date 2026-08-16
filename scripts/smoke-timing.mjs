// Timing diagnostic for first-exec latency.
import { SessionManager } from "smart-terminal-mcp/src/session-manager.js";

const manager = new SessionManager();
const t0 = Date.now();
const session = await manager.create({ name: "smoke2" });
console.log(`create: ${Date.now() - t0}ms`);

const t1 = Date.now();
await session.waitForBanner();
console.log(`banner: ${Date.now() - t1}ms`);

for (const cmd of ["echo FIRST", "echo SECOND"]) {
	const t = Date.now();
	const r = await session.exec({ command: cmd, timeout: 45000 });
	console.log(
		`${cmd}: ${Date.now() - t}ms exit=${r.exitCode} timedOut=${r.timedOut} out=${JSON.stringify(r.output.trim())}`,
	);
}

manager.destroyAll();
process.exit(0);
