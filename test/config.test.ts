import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIG, mergeConfig } from "../src/config.js";

describe("mergeConfig", () => {
	it("returns defaults for non-object input", () => {
		expect(mergeConfig(null)).toEqual(DEFAULT_CONFIG);
		expect(mergeConfig("nope")).toEqual(DEFAULT_CONFIG);
		expect(mergeConfig(42)).toEqual(DEFAULT_CONFIG);
	});

	it("applies valid overrides", () => {
		const merged = mergeConfig({
			overrideBash: false,
			userBash: true,
			bashTimeoutMs: 5000,
			footer: false,
			defaultShell: "pwsh.exe",
			allToolsActive: true,
		});
		expect(merged).toEqual({
			overrideBash: false,
			userBash: true,
			bashTimeoutMs: 5000,
			footer: false,
			defaultShell: "pwsh.exe",
			allToolsActive: true,
		});
	});

	it("ignores unknown keys and invalid values", () => {
		const merged = mergeConfig({ overrideBash: "yes", hack: true, bashTimeoutMs: 10 });
		expect(merged).toEqual(DEFAULT_CONFIG);
	});

	it("rounds and floors numeric timeouts, rejects < 1000ms", () => {
		expect(mergeConfig({ bashTimeoutMs: 1500.7 }).bashTimeoutMs).toBe(1500);
		expect(mergeConfig({ bashTimeoutMs: 999 }).bashTimeoutMs).toBe(DEFAULT_CONFIG.bashTimeoutMs);
	});

	it("ignores empty string shell", () => {
		expect(mergeConfig({ defaultShell: "" }).defaultShell).toBeNull();
	});
});
