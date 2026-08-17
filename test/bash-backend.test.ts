import { describe, expect, it } from "vitest";

import { needsSingleLine, toPowershellSingleLine } from "../src/bash-backend.js";

describe("needsSingleLine", () => {
	it("flags multi-line commands only for line-continuation-hostile shells", () => {
		expect(needsSingleLine("node -e \"\nfoo\n\"", "powershell")).toBe(true);
		expect(needsSingleLine("node -e \"\nfoo\n\"", "cmd")).toBe(true);
		expect(needsSingleLine("node -e \"\nfoo\n\"", "bash")).toBe(false);
		expect(needsSingleLine("single line", "powershell")).toBe(false);
		expect(needsSingleLine("single line", undefined)).toBe(false);
		expect(needsSingleLine("has\rcr", "powershell")).toBe(true);
	});
});

describe("toPowershellSingleLine", () => {
	it("produces a single-line iex/base64 wrapper decoding to the exact payload", () => {
		const cmd = "node -e \"\nconst NL='\\r\\n';\nconsole.log('x');\n\"";
		const wrapped = toPowershellSingleLine(cmd);
		expect(wrapped).not.toMatch(/[\r\n]/);
		expect(wrapped).toMatch(/^iex \(\[Text\.Encoding\]::UTF8\.GetString\(\[Convert\]::FromBase64String\('[A-Za-z0-9+/=]+'\)\)\)$/);

		const b64 = wrapped.match(/FromBase64String\('([^']+)'/)![1];
		expect(Buffer.from(b64, "base64").toString("utf8")).toBe(cmd);
	});

	it("keeps non-ASCII payloads byte-exact", () => {
		const cmd = "echo 'héllo — ±30% → done'";
		const b64 = toPowershellSingleLine(cmd).match(/FromBase64String\('([^']+)'/)![1];
		expect(Buffer.from(b64, "base64").toString("utf8")).toBe(cmd);
	});
});
