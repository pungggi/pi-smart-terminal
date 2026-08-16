// Load the extension via jiti (like pi does), drive it with a mock ExtensionAPI.
import { pathToFileURL } from "node:url";
const jitiPkg = "C:/Users/Alessandro/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";
const { createJiti } = await import(pathToFileURL(jitiPkg).href);

const jiti = createJiti(import.meta.url);

const registered = { tools: [], commands: [], handlers: {} };
const mockCtxBase = {
	cwd: process.cwd(),
	mode: "tui",
	hasUI: false,
	ui: { notify() {}, setStatus() {}, select: async () => undefined },
};

const pi = {
	on(event, handler) {
		registered.handlers[event] ??= [];
		registered.handlers[event].push(handler);
	},
	registerTool(def) {
		registered.tools.push(def.name);
		registered.toolDefs ??= [];
		registered.toolDefs.push(def);
	},
	registerCommand(name) {
		registered.commands.push(name);
	},
	getActiveTools: () => ["bash", "read", "edit", "write", "terminal_exec", "terminal_watch"],
	setActiveTools(names) {
		registered.activeTools = names;
	},
	getAllTools: () => [],
	sendUserMessage() {},
};

console.log("loading extension via jiti…");
const t0 = Date.now();
const mod = await jiti.import(pathToFileURL("C:/Users/Alessandro/source/pi/packages/pi-smart-terminal/src/index.ts").href);
const factory = mod.default;
console.log(`loaded in ${Date.now() - t0}ms; factory:`, typeof factory);

factory(pi);
console.log("factory returned (sync part ok)");

// Drive session_start with a 10s timeout
const t1 = Date.now();
const timeout = setTimeout(() => {
	console.error("!! session_start handler did not resolve in 10s — THIS is the hang");
	process.exit(1);
}, 10000);

for (const handler of registered.handlers.session_start ?? []) {
	await handler({ reason: "startup" }, mockCtxBase);
}
clearTimeout(timeout);

console.log(`session_start resolved in ${Date.now() - t1}ms`);
console.log("registered tools:", registered.tools.join(", "));
console.log("registered commands:", registered.commands.join(", "));
console.log("active tools after:", (registered.activeTools ?? []).join(", "));

// Execute the PTY-backed bash tool end-to-end.
const bashDef = registered.toolDefs?.find((t) => t.name === "bash");
if (bashDef) {
	console.log("executing bash tool: echo SMOKE_BASH_OK");
	const t2 = Date.now();
	let chunks = "";
	const result = await bashDef.execute("call-1", { command: "echo SMOKE_BASH_OK" }, undefined, (u) => {
		chunks += u.content?.[0]?.text ?? "";
	});
	console.log(`bash execute: ${Date.now() - t2}ms`);
	console.log("content:", JSON.stringify(result.content[0].text));
	console.log("isError-style throw? no — returned normally");
} else {
	console.log("!! bash tool definition not captured");
}
process.exit(0);
