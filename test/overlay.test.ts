import { describe, expect, it } from "vitest";

import {
	clampOffset,
	computeVisibleRange,
	nextSessionIndex,
	scrollPercent,
	scrollViewport,
} from "../src/overlay.js";

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

describe("nextSessionIndex", () => {
	it("wraps forward and backward", () => {
		const ids = ["a", "b", "c"];
		expect(nextSessionIndex(ids, "a", 1)).toBe(1);
		expect(nextSessionIndex(ids, "c", 1)).toBe(0);
		expect(nextSessionIndex(ids, "a", -1)).toBe(2);
		expect(nextSessionIndex(ids, "b", -1)).toBe(0);
	});

	it("falls back to the first session when current is unknown", () => {
		expect(nextSessionIndex(["a", "b"], "gone", 1)).toBe(0);
		expect(nextSessionIndex([], "a", 1)).toBe(-1);
	});
});

describe("scrollPercent", () => {
	it("returns null at the tail or when nothing is scrollable", () => {
		expect(scrollPercent({ offset: 0, follow: true }, 100, 10)).toBeNull();
		expect(scrollPercent({ offset: 5, follow: false }, 5, 10)).toBeNull();
	});

	it("reports position within the scrollable range", () => {
		// scrollable = 90; offset 45 → halfway (50%)
		expect(scrollPercent({ offset: 45, follow: false }, 100, 10)).toBe(50);
		// at the very top of history
		expect(scrollPercent({ offset: 90, follow: false }, 100, 10)).toBe(0);
		// one page short of the tail
		expect(scrollPercent({ offset: 9, follow: false }, 100, 10)).toBe(90);
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
