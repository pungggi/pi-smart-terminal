// Direct smoke test of the upstream core from this package's node_modules.
import { SessionManager } from "smart-terminal-mcp/src/session-manager.js";

const manager = new SessionManager();
const session = await manager.create({ name: "smoke" });
console.log("session:", session.id, "shell:", session.shell, "cwd:", session.cwd);

const banner = await session.waitForBanner();
console.log("banner:", banner.split("\n")[0].slice(0, 60));

const r1 = await session.exec({ command: "echo SMOKE_CORE_OK", timeout: 15000 });
console.log("exec1:", JSON.stringify(r1.output.trim()), "exit:", r1.exitCode);

// Persistence check: cd must carry over.
await session.exec({ command: "cd ..", timeout: 15000 });
const r2 = await session.exec({ command: "echo $PWD", timeout: 15000 });
console.log("exec2 cwd:", session.cwd, "persisted:", r2.cwd);

manager.destroyAll();
console.log("CORE SMOKE PASSED");
process.exit(0);
