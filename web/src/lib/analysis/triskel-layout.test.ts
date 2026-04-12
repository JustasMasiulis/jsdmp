import { describe, expect, it } from "bun:test";
import { type TriskelInput, triskelLayout } from "./triskel-layout";

function makeInput(
	nodeCount: number,
	edges: Array<{ src: number; dst: number }>,
	width = 100,
	height = 40,
	root = 0,
): TriskelInput {
	const nodeWidths = new Float64Array(nodeCount).fill(width);
	const nodeHeights = new Float64Array(nodeCount).fill(height);
	return { nodeCount, edges, nodeWidths, nodeHeights, root };
}

function nodesOverlap(
	input: TriskelInput,
	xs: Float64Array,
	ys: Float64Array,
): boolean {
	for (let i = 0; i < input.nodeCount; i++) {
		for (let j = i + 1; j < input.nodeCount; j++) {
			const overlapX =
				xs[i] < xs[j] + input.nodeWidths[j] &&
				xs[j] < xs[i] + input.nodeWidths[i];
			const overlapY =
				ys[i] < ys[j] + input.nodeHeights[j] &&
				ys[j] < ys[i] + input.nodeHeights[i];
			if (overlapX && overlapY) return false;
		}
	}
	return true;
}

describe("triskelLayout", () => {
	it("handles empty graph", () => {
		const result = triskelLayout(makeInput(0, []));
		expect(result.xs.length).toBe(0);
		expect(result.ys.length).toBe(0);
		expect(result.edgePolylines.length).toBe(0);
	});

	it("places single node at origin", () => {
		const result = triskelLayout(makeInput(1, []));
		expect(result.xs.length).toBe(1);
		expect(result.ys.length).toBe(1);
		expect(Number.isFinite(result.xs[0])).toBe(true);
		expect(Number.isFinite(result.ys[0])).toBe(true);
		expect(result.edgePolylines.length).toBe(0);
	});

	it("places single edge with source above destination", () => {
		const input = makeInput(2, [{ src: 0, dst: 1 }]);
		const result = triskelLayout(input);
		expect(result.xs.length).toBe(2);
		expect(result.ys[0]).toBeLessThan(result.ys[1]);
		expect(result.edgePolylines.length).toBe(1);
	});

	it("lays out a chain vertically", () => {
		const edges = [
			{ src: 0, dst: 1 },
			{ src: 1, dst: 2 },
			{ src: 2, dst: 3 },
		];
		const input = makeInput(4, edges);
		const result = triskelLayout(input);

		for (let i = 0; i < 3; i++) {
			expect(result.ys[i]).toBeLessThan(result.ys[i + 1]);
		}

		expect(nodesOverlap(input, result.xs, result.ys)).toBe(true);
	});

	it("lays out a diamond without overlaps", () => {
		const edges = [
			{ src: 0, dst: 1 },
			{ src: 0, dst: 2 },
			{ src: 1, dst: 3 },
			{ src: 2, dst: 3 },
		];
		const input = makeInput(4, edges);
		const result = triskelLayout(input);

		expect(result.xs.length).toBe(4);
		expect(result.ys.length).toBe(4);
		expect(result.edgePolylines.length).toBe(4);
		expect(result.ys[0]).toBeLessThan(result.ys[3]);
		expect(nodesOverlap(input, result.xs, result.ys)).toBe(true);
	});

	it("handles cycles", () => {
		const edges = [
			{ src: 0, dst: 1 },
			{ src: 1, dst: 2 },
			{ src: 2, dst: 0 },
			{ src: 2, dst: 3 },
		];
		const input = makeInput(4, edges);
		const result = triskelLayout(input);

		for (let i = 0; i < 4; i++) {
			expect(Number.isFinite(result.xs[i])).toBe(true);
			expect(Number.isFinite(result.ys[i])).toBe(true);
		}

		expect(nodesOverlap(input, result.xs, result.ys)).toBe(true);
	});

	it("places fan-in node below its predecessors", () => {
		const edges = [
			{ src: 0, dst: 3 },
			{ src: 1, dst: 3 },
			{ src: 2, dst: 3 },
		];
		const input = makeInput(4, edges);
		const result = triskelLayout(input);

		expect(result.ys[3]).toBeGreaterThan(result.ys[0]);
		expect(result.ys[3]).toBeGreaterThan(result.ys[1]);
		expect(result.ys[3]).toBeGreaterThan(result.ys[2]);
	});

	it("lays out if-then-else correctly", () => {
		const edges = [
			{ src: 0, dst: 1 },
			{ src: 0, dst: 2 },
			{ src: 1, dst: 3 },
			{ src: 2, dst: 3 },
		];
		const input = makeInput(4, edges);
		const result = triskelLayout(input);

		expect(result.ys[0]).toBeLessThan(result.ys[1]);
		expect(result.ys[0]).toBeLessThan(result.ys[2]);
		expect(result.ys[1]).toBeLessThan(result.ys[3]);
		expect(result.ys[2]).toBeLessThan(result.ys[3]);
		expect(nodesOverlap(input, result.xs, result.ys)).toBe(true);
	});

	it("produces no overlapping nodes for various graphs", () => {
		const graphs = [
			makeInput(2, [{ src: 0, dst: 1 }]),
			makeInput(3, [
				{ src: 0, dst: 1 },
				{ src: 0, dst: 2 },
			]),
			makeInput(5, [
				{ src: 0, dst: 1 },
				{ src: 0, dst: 2 },
				{ src: 1, dst: 3 },
				{ src: 2, dst: 3 },
				{ src: 3, dst: 4 },
			]),
		];

		for (const input of graphs) {
			const result = triskelLayout(input);
			expect(nodesOverlap(input, result.xs, result.ys)).toBe(true);
		}
	});

	it("produces valid polylines with at least 2 points", () => {
		const edges = [
			{ src: 0, dst: 1 },
			{ src: 0, dst: 2 },
			{ src: 1, dst: 3 },
			{ src: 2, dst: 3 },
		];
		const input = makeInput(4, edges);
		const result = triskelLayout(input);

		for (const polyline of result.edgePolylines) {
			expect(polyline.length).toBeGreaterThanOrEqual(2);
			for (const pt of polyline) {
				expect(Number.isFinite(pt.x)).toBe(true);
				expect(Number.isFinite(pt.y)).toBe(true);
			}
		}
	});

	it("produces polylines near source and destination", () => {
		const edges = [{ src: 0, dst: 1 }];
		const input = makeInput(2, edges, 100, 40);
		const result = triskelLayout(input);
		const polyline = result.edgePolylines[0];

		const srcCx = result.xs[0] + 50;
		const srcBottom = result.ys[0] + 40;
		const dstCx = result.xs[1] + 50;
		const dstTop = result.ys[1];

		const TOLERANCE = 60;
		expect(Math.abs(polyline[0].x - srcCx)).toBeLessThan(TOLERANCE);
		expect(Math.abs(polyline[0].y - srcBottom)).toBeLessThan(TOLERANCE);
		expect(Math.abs(polyline[polyline.length - 1].x - dstCx)).toBeLessThan(
			TOLERANCE,
		);
		expect(Math.abs(polyline[polyline.length - 1].y - dstTop)).toBeLessThan(
			TOLERANCE,
		);
	});
});
