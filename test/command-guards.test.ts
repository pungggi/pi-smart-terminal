import { describe, expect, it } from "vitest";

import { assertPagedCommandIsReadOnly } from "../src/command-guards.js";

describe("assertPagedCommandIsReadOnly", () => {
	it("allows allowlisted read-only commands", () => {
		expect(() => assertPagedCommandIsReadOnly("tasklist")).not.toThrow();
		expect(() => assertPagedCommandIsReadOnly("where", ["node"])).not.toThrow();
		expect(() => assertPagedCommandIsReadOnly("git", ["status"])).not.toThrow();
		expect(() => assertPagedCommandIsReadOnly("git", ["log", "--oneline"])).not.toThrow();
	});

	it("rejects mutating git subcommands", () => {
		expect(() => assertPagedCommandIsReadOnly("git", ["push"])).toThrow(/read-only/);
		expect(() => assertPagedCommandIsReadOnly("git", ["reset", "--hard"])).toThrow(/read-only/);
	});

	it("rejects arbitrary commands", () => {
		expect(() => assertPagedCommandIsReadOnly("npm", ["install"])).toThrow(/read-only/);
		expect(() => assertPagedCommandIsReadOnly("rm", ["-rf", "/"])).toThrow(/read-only/);
	});
});
