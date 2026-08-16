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
			footer: "minimal",
			defaultShell: "pwsh.exe",
			allToolsActive: true,
		});
		expect(merged).toEqual({
			overrideBash: false,
			userBash: true,
			bashTimeoutMs: 5000,
			footer: "minimal",
			defaultShell: "pwsh.exe",
			allToolsActive: true,
		});
	});

	it("maps boolean footer values for backward compatibility", () => {
		expect(mergeConfig({ footer: true }).footer).toBe("full");
		expect(mergeConfig({ footer: false }).footer).toBe("off");
	});

	it("accepts all footer modes, rejects unknown strings", () => {
		for (const mode of ["auto", "minimal", "full", "off"] as const) {
			expect(mergeConfig({ footer: mode }).footer).toBe(mode);
		}
		expect(mergeConfig({ footer: "noisy" }).footer).toBe(DEFAULT_CONFIG.footer);
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
