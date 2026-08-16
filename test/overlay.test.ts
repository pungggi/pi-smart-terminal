import { describe, expect, it } from "vitest";

import { clampOffset, computeVisibleRange, scrollViewport } from "../src/overlay.js";

describe("clampOffset", () => {
	it("clamps to [0, totalLines-1]", () => {
		expect(clampOffset(-5, 100)).toBe(0);
		expect(clampOffset(500, 100)).toBe(99);
		expect(clampOffset(42, 100)).toBe(42);
	});

	it("handles empty histories", () => {
		expect(clampOffset(10, 0)).toBe(0);
	});
});

describe("scrollViewport", () => {
	it("scrolling up disables follow; reaching bottom re-enables it", () => {
		const state = { offset: 0, follow: true };
		const up = scrollViewport(state, 10, 100);
		expect(up).toEqual({ offset: 10, follow: false });

		const backDown = scrollViewport(up, -10, 100);
		expect(backDown).toEqual({ offset: 0, follow: true });
	});

	it("clamps at the top of history", () => {
		expect(scrollViewport({ offset: 95, follow: false }, 50, 100)).toEqual({
			offset: 99,
			follow: false,
		});
	});
});

describe("computeVisibleRange", () => {
	it("follow mode shows the last bodyHeight lines", () => {
		expect(computeVisibleRange({ offset: 0, follow: true }, 100, 10)).toEqual({
			start: 90,
			end: 100,
			following: true,
		});
	});

	it("offset mode shows a window ending offset lines before the end", () => {
		expect(computeVisibleRange({ offset: 20, follow: false }, 100, 10)).toEqual({
			start: 70,
			end: 80,
			following: false,
		});
	});

	it("handles histories shorter than the body", () => {
		expect(computeVisibleRange({ offset: 0, follow: true }, 3, 10)).toEqual({
			start: 0,
			end: 3,
			following: true,
		});
	});
});
