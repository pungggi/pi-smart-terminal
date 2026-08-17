// npm search-index status for our packages (by-name, single request per name)
// Usage: node scripts/check-index.mjs
const NAMES = ["pi-smart-terminal", "pi-powershell", "pi-schedule", "pi-session-finder", "pi-posh-git"];

for (const n of NAMES) {
	const url = `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(n)}&size=20&from=0`;
	const res = await fetch(url);
	if (!res.ok) throw new Error(`search ${res.status} for ${n}`);
	const j = await res.json();
	const hit = j.objects.find((o) => o.package.name === n);
	console.log(n.padEnd(20), hit ? "indexed " + hit.package.version : "NOT in index");
}
