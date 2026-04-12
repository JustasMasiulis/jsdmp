import { describe, expect, it } from "bun:test";

import { buildTreeIntervals, isStrictAncestor } from "./tree-ancestry";

describe("tree ancestry helpers", () => {
	it("treats only strict ancestors as succeeding nodes", () => {
		const children = [[1, 2], [3], [], []];
		const intervals = buildTreeIntervals(children, 0);

		expect(isStrictAncestor(intervals, 3, 1)).toBe(true);
		expect(isStrictAncestor(intervals, 3, 0)).toBe(true);
		expect(isStrictAncestor(intervals, 2, 1)).toBe(false);
		expect(isStrictAncestor(intervals, 1, 1)).toBe(false);
	});

	it("returns zeroed intervals for an invalid root", () => {
		const intervals = buildTreeIntervals([], 0);

		expect(intervals.enter.length).toBe(0);
		expect(intervals.exit.length).toBe(0);
	});
});
