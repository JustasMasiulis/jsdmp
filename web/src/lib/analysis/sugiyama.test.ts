import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	__testing,
	computeCfgAnalysis,
	type SugiyamaInput,
	sugiyamaLayout,
	veilConfig,
} from "./sugiyama";

const X_GUTTER = 20;

function makeInput(
	nodeCount: number,
	edges: { src: number; dst: number }[],
	widths?: number[],
	heights?: number[],
	root = 0,
): SugiyamaInput {
	const w = widths ?? new Array(nodeCount).fill(100);
	const h = heights ?? new Array(nodeCount).fill(40);
	return {
		nodeCount,
		edges,
		nodeWidths: new Float64Array(w),
		nodeHeights: new Float64Array(h),
		root,
	};
}

function assertNoOverlaps(
	input: SugiyamaInput,
	xs: Float64Array,
	ys: Float64Array,
): void {
	for (let i = 0; i < input.nodeCount; i++) {
		for (let j = i + 1; j < input.nodeCount; j++) {
			if (Math.abs(ys[i] - ys[j]) > 1) continue;
			const rightI = xs[i] + input.nodeWidths[i];
			const rightJ = xs[j] + input.nodeWidths[j];
			const gap = xs[i] < xs[j] ? xs[j] - rightI : xs[i] - rightJ;
			expect(gap).toBeGreaterThanOrEqual(X_GUTTER - 1);
		}
	}
}

function assertAllFinite(xs: Float64Array, ys: Float64Array): void {
	for (let i = 0; i < xs.length; i++) {
		expect(Number.isFinite(xs[i])).toBe(true);
		expect(Number.isFinite(ys[i])).toBe(true);
		expect(Number.isNaN(xs[i])).toBe(false);
		expect(Number.isNaN(ys[i])).toBe(false);
	}
}

function assertNonNegativePositions(xs: Float64Array, ys: Float64Array): void {
	for (let i = 0; i < xs.length; i++) {
		expect(xs[i]).toBeGreaterThanOrEqual(-1);
		expect(ys[i]).toBeGreaterThanOrEqual(-1);
	}
}

function assertEdgeConnectsNodes(
	input: SugiyamaInput,
	result: ReturnType<typeof sugiyamaLayout>,
	edgeIdx: number,
): void {
	const { src, dst } = input.edges[edgeIdx];
	const polyline = result.edgePolylines[edgeIdx];
	expect(polyline.length).toBeGreaterThanOrEqual(2);

	const firstPt = polyline[0];
	const lastPt = polyline[polyline.length - 1];

	const srcLeft = result.xs[src];
	const srcRight = srcLeft + input.nodeWidths[src];
	const srcTop = result.ys[src];
	const srcBottom = srcTop + input.nodeHeights[src];

	const dstLeft = result.xs[dst];
	const dstRight = dstLeft + input.nodeWidths[dst];
	const dstTop = result.ys[dst];
	const dstBottom = dstTop + input.nodeHeights[dst];

	const nearSrc =
		firstPt.x >= srcLeft - 1 &&
		firstPt.x <= srcRight + 1 &&
		firstPt.y >= srcTop - 1 &&
		firstPt.y <= srcBottom + 1;
	const nearDst =
		lastPt.x >= dstLeft - 1 &&
		lastPt.x <= dstRight + 1 &&
		lastPt.y >= dstTop - 1 &&
		lastPt.y <= dstBottom + 1;

	expect(nearSrc).toBe(true);
	expect(nearDst).toBe(true);
}

describe("sugiyamaLayout", () => {
	it("empty graph", () => {
		const r = sugiyamaLayout(makeInput(0, []));
		expect(r.xs.length).toBe(0);
		expect(r.edgePolylines.length).toBe(0);
	});

	it("single node", () => {
		const r = sugiyamaLayout(makeInput(1, []));
		expect(r.xs.length).toBe(1);
		expect(r.ys[0]).toBe(0);
	});

	it("single edge: src above dst, polyline connects both", () => {
		const input = makeInput(2, [{ src: 0, dst: 1 }]);
		const r = sugiyamaLayout(input);
		expect(r.ys[0]).toBeLessThan(r.ys[1]);
		assertEdgeConnectsNodes(input, r, 0);
	});

	it("chain: vertical alignment, polylines connect", () => {
		const input = makeInput(4, [
			{ src: 0, dst: 1 },
			{ src: 1, dst: 2 },
			{ src: 2, dst: 3 },
		]);
		const r = sugiyamaLayout(input);

		for (let i = 0; i < 3; i++) {
			expect(r.ys[i]).toBeLessThan(r.ys[i + 1]);
		}

		const c0 = r.xs[0] + input.nodeWidths[0] / 2;
		for (let i = 1; i < 4; i++) {
			expect(Math.abs(r.xs[i] + input.nodeWidths[i] / 2 - c0)).toBeLessThan(2);
		}

		for (let i = 0; i < 3; i++) assertEdgeConnectsNodes(input, r, i);
	});

	it("diamond: correct layers, no overlaps, polylines connect", () => {
		const input = makeInput(4, [
			{ src: 0, dst: 1 },
			{ src: 0, dst: 2 },
			{ src: 1, dst: 3 },
			{ src: 2, dst: 3 },
		]);
		const r = sugiyamaLayout(input);

		expect(r.ys[0]).toBeLessThan(r.ys[1]);
		expect(r.ys[0]).toBeLessThan(r.ys[2]);
		expect(Math.abs(r.ys[1] - r.ys[2])).toBeLessThan(1);
		expect(r.ys[1]).toBeLessThan(r.ys[3]);

		assertNoOverlaps(input, r.xs, r.ys);
		for (let i = 0; i < 4; i++) assertEdgeConnectsNodes(input, r, i);
	});

	it("fan-out: children on same layer, no overlaps", () => {
		const edges = [];
		for (let i = 1; i <= 5; i++) edges.push({ src: 0, dst: i });
		const input = makeInput(6, edges);
		const r = sugiyamaLayout(input);

		for (let i = 2; i <= 5; i++) {
			expect(Math.abs(r.ys[i] - r.ys[1])).toBeLessThan(1);
		}
		assertNoOverlaps(input, r.xs, r.ys);
		for (let i = 0; i < edges.length; i++) assertEdgeConnectsNodes(input, r, i);
	});

	it("varied widths: no overlaps", () => {
		const input = makeInput(
			4,
			[
				{ src: 0, dst: 1 },
				{ src: 0, dst: 2 },
				{ src: 1, dst: 3 },
				{ src: 2, dst: 3 },
			],
			[200, 150, 80, 120],
		);
		const r = sugiyamaLayout(input);
		assertNoOverlaps(input, r.xs, r.ys);
		assertNonNegativePositions(r.xs, r.ys);
	});

	it("simple cycle: positions finite, layers correct", () => {
		const input = makeInput(3, [
			{ src: 0, dst: 1 },
			{ src: 1, dst: 2 },
			{ src: 2, dst: 0 },
		]);
		const r = sugiyamaLayout(input);
		assertAllFinite(r.xs, r.ys);
		expect(r.ys[0]).toBeLessThan(r.ys[1]);
		expect(r.ys[1]).toBeLessThan(r.ys[2]);
	});

	it("simple cycle: wrapped backedge sets top and bottom loop flags", () => {
		const input = makeInput(3, [
			{ src: 0, dst: 1 },
			{ src: 1, dst: 2 },
			{ src: 2, dst: 0 },
		]);
		const r = sugiyamaLayout(input);

		expect(r.hasTopLoop).toBe(true);
		expect(r.hasBottomLoop).toBe(true);
	});

	it("cycle removal only touches the root-reachable component", () => {
		const succs = [[1], [], [3], [2]];
		const preds = [[], [0], [3], [2]];
		const edgeIndicesFromNode = [[0], [], [1], [2]];
		const isFlipped = new Uint8Array(3);
		const selfLoopEdges: number[] = [];
		const paddings = new Float64Array(4 * 4);

		__testing.cycleRemoval(
			4,
			0,
			succs,
			preds,
			isFlipped,
			edgeIndicesFromNode,
			selfLoopEdges,
			paddings,
		);

		expect(Array.from(isFlipped)).toEqual([0, 0, 0]);
		expect(succs[2]).toEqual([3]);
		expect(succs[3]).toEqual([2]);
	});

	it("cycle: back edge polyline connects original src to original dst", () => {
		const input = makeInput(3, [
			{ src: 0, dst: 1 },
			{ src: 1, dst: 2 },
			{ src: 2, dst: 0 },
		]);
		const r = sugiyamaLayout(input);
		for (let i = 0; i < 3; i++) assertEdgeConnectsNodes(input, r, i);
	});

	it("self-loop: non-empty polyline with 6 waypoints, other edges correct", () => {
		const input = makeInput(2, [
			{ src: 0, dst: 0 },
			{ src: 0, dst: 1 },
		]);
		const r = sugiyamaLayout(input);
		expect(r.edgePolylines[0].length).toBe(6);
		for (const pt of r.edgePolylines[0]) {
			expect(Number.isFinite(pt.x)).toBe(true);
			expect(Number.isFinite(pt.y)).toBe(true);
		}
		assertEdgeConnectsNodes(input, r, 1);
	});

	it("long edge: waypoints go downward, connect correctly", () => {
		const input = makeInput(4, [
			{ src: 0, dst: 1 },
			{ src: 1, dst: 2 },
			{ src: 2, dst: 3 },
			{ src: 0, dst: 3 },
		]);
		const r = sugiyamaLayout(input);

		assertEdgeConnectsNodes(input, r, 3);

		const longPoly = r.edgePolylines[3];
		for (let i = 0; i < longPoly.length - 1; i++) {
			expect(longPoly[i].y).toBeLessThanOrEqual(longPoly[i + 1].y + 1);
		}
	});

	it("parallel edges keep distinct waypoint slots", () => {
		const input = makeInput(2, [
			{ src: 0, dst: 1 },
			{ src: 0, dst: 1 },
		]);
		const r = sugiyamaLayout(input);

		assertEdgeConnectsNodes(input, r, 0);
		assertEdgeConnectsNodes(input, r, 1);

		const first0 = r.edgePolylines[0][0];
		const first1 = r.edgePolylines[1][0];
		const last0 = r.edgePolylines[0][r.edgePolylines[0].length - 1];
		const last1 = r.edgePolylines[1][r.edgePolylines[1].length - 1];

		expect(Math.abs(first0.x - first1.x)).toBeGreaterThan(1);
		expect(Math.abs(last0.x - last1.x)).toBeGreaterThan(1);
	});

	it("parent roughly centered above children", () => {
		const input = makeInput(
			4,
			[
				{ src: 0, dst: 1 },
				{ src: 0, dst: 2 },
				{ src: 1, dst: 3 },
				{ src: 2, dst: 3 },
			],
			[100, 100, 100, 100],
		);
		const r = sugiyamaLayout(input);
		const c0 = r.xs[0] + 50;
		const c1 = r.xs[1] + 50;
		const c2 = r.xs[2] + 50;
		const childMin = Math.min(c1, c2);
		const childMax = Math.max(c1, c2);
		expect(c0).toBeGreaterThanOrEqual(childMin - 10);
		expect(c0).toBeLessThanOrEqual(childMax + 10);
	});

	it("many-node fan-out: no overlaps with varied widths", () => {
		const edges = [];
		for (let i = 1; i <= 8; i++) edges.push({ src: 0, dst: i });
		const widths = [120, 80, 150, 60, 200, 90, 110, 70, 130];
		const input = makeInput(9, edges, widths);
		const r = sugiyamaLayout(input);
		assertNoOverlaps(input, r.xs, r.ys);
		assertNonNegativePositions(r.xs, r.ys);
	});

	it("multiple roots: no overlaps", () => {
		const input = makeInput(3, [
			{ src: 0, dst: 2 },
			{ src: 1, dst: 2 },
		]);
		const r = sugiyamaLayout(input);
		expect(Math.abs(r.ys[0] - r.ys[1])).toBeLessThan(1);
		expect(r.ys[0]).toBeLessThan(r.ys[2]);
		assertNoOverlaps(input, r.xs, r.ys);
	});

	it("if-then-else CFG: correct structure and edges", () => {
		const input = makeInput(
			6,
			[
				{ src: 0, dst: 1 },
				{ src: 0, dst: 2 },
				{ src: 1, dst: 3 },
				{ src: 2, dst: 4 },
				{ src: 3, dst: 5 },
				{ src: 4, dst: 5 },
			],
			[180, 120, 120, 140, 100, 160],
			[60, 40, 40, 80, 50, 70],
		);
		const r = sugiyamaLayout(input);

		expect(r.ys[0]).toBeLessThan(r.ys[1]);
		expect(r.ys[1]).toBeLessThan(r.ys[3]);
		expect(r.ys[3]).toBeLessThan(r.ys[5]);
		assertNoOverlaps(input, r.xs, r.ys);
		for (let i = 0; i < 6; i++) assertEdgeConnectsNodes(input, r, i);
	});

	it("loop with exit: layering and back edge correct", () => {
		const input = makeInput(4, [
			{ src: 0, dst: 1 },
			{ src: 1, dst: 2 },
			{ src: 2, dst: 1 },
			{ src: 2, dst: 3 },
		]);
		const r = sugiyamaLayout(input);

		expect(r.ys[0]).toBeLessThan(r.ys[1]);
		expect(r.ys[1]).toBeLessThan(r.ys[2]);
		assertAllFinite(r.xs, r.ys);

		for (let i = 0; i < 4; i++) assertEdgeConnectsNodes(input, r, i);
	});

	it("nested loops: all edges connect correctly", () => {
		const input = makeInput(5, [
			{ src: 0, dst: 1 },
			{ src: 1, dst: 2 },
			{ src: 2, dst: 3 },
			{ src: 3, dst: 1 },
			{ src: 3, dst: 4 },
			{ src: 2, dst: 0 },
		]);
		const r = sugiyamaLayout(input);
		assertAllFinite(r.xs, r.ys);
		for (let i = 0; i < 6; i++) assertEdgeConnectsNodes(input, r, i);
	});

	it("realistic CFG: entry, branches, loop, merge, exit", () => {
		const input = makeInput(
			8,
			[
				{ src: 0, dst: 1 },
				{ src: 1, dst: 2 },
				{ src: 1, dst: 3 },
				{ src: 2, dst: 4 },
				{ src: 3, dst: 4 },
				{ src: 4, dst: 5 },
				{ src: 5, dst: 6 },
				{ src: 6, dst: 4 },
				{ src: 6, dst: 7 },
			],
			[150, 120, 100, 100, 130, 110, 90, 140],
			[50, 40, 30, 30, 45, 35, 25, 55],
		);
		const r = sugiyamaLayout(input);

		assertAllFinite(r.xs, r.ys);
		assertNoOverlaps(input, r.xs, r.ys);
		assertNonNegativePositions(r.xs, r.ys);

		expect(r.ys[0]).toBeLessThan(r.ys[1]);
		expect(r.ys[1]).toBeLessThan(r.ys[2]);

		for (let i = 0; i < 9; i++) assertEdgeConnectsNodes(input, r, i);
	});

	it("all polyline points have finite, non-extreme coordinates", () => {
		const input = makeInput(
			6,
			[
				{ src: 0, dst: 1 },
				{ src: 0, dst: 2 },
				{ src: 1, dst: 3 },
				{ src: 2, dst: 3 },
				{ src: 3, dst: 4 },
				{ src: 4, dst: 5 },
				{ src: 5, dst: 3 },
			],
			[120, 80, 80, 100, 90, 70],
		);
		const r = sugiyamaLayout(input);

		const maxBound = (input.nodeCount + 5) * 300;
		for (let i = 0; i < r.edgePolylines.length; i++) {
			for (const pt of r.edgePolylines[i]) {
				expect(Number.isFinite(pt.x)).toBe(true);
				expect(Number.isFinite(pt.y)).toBe(true);
				expect(Math.abs(pt.x)).toBeLessThan(maxBound);
				expect(Math.abs(pt.y)).toBeLessThan(maxBound);
			}
		}
	});

	it("edge count matches input", () => {
		const input = makeInput(4, [
			{ src: 0, dst: 1 },
			{ src: 0, dst: 2 },
			{ src: 1, dst: 3 },
			{ src: 2, dst: 3 },
		]);
		const r = sugiyamaLayout(input);
		expect(r.edgePolylines.length).toBe(input.edges.length);
	});

	it("polyline for downward edge goes monotonically down", () => {
		const input = makeInput(3, [
			{ src: 0, dst: 1 },
			{ src: 1, dst: 2 },
		]);
		const r = sugiyamaLayout(input);

		for (const polyline of r.edgePolylines) {
			if (polyline.length < 2) continue;
			for (let i = 0; i < polyline.length - 1; i++) {
				expect(polyline[i].y).toBeLessThanOrEqual(polyline[i + 1].y + 0.5);
			}
		}
	});

	it("switch pattern: wide fan-out to fan-in", () => {
		const input = makeInput(
			7,
			[
				{ src: 0, dst: 1 },
				{ src: 0, dst: 2 },
				{ src: 0, dst: 3 },
				{ src: 1, dst: 4 },
				{ src: 2, dst: 5 },
				{ src: 3, dst: 6 },
				{ src: 4, dst: 6 },
				{ src: 5, dst: 6 },
			],
			[150, 100, 100, 100, 80, 80, 140],
		);
		const r = sugiyamaLayout(input);
		assertNoOverlaps(input, r.xs, r.ys);
		assertAllFinite(r.xs, r.ys);
		for (let i = 0; i < 8; i++) assertEdgeConnectsNodes(input, r, i);
	});

	it("self-loop: 6-point waypoints wrapping around the node", () => {
		const input = makeInput(3, [
			{ src: 0, dst: 1 },
			{ src: 1, dst: 1 },
			{ src: 1, dst: 2 },
		]);
		const r = sugiyamaLayout(input);
		assertAllFinite(r.xs, r.ys);

		const selfLoopPoly = r.edgePolylines[1];
		expect(selfLoopPoly.length).toBe(6);

		const nodeX = r.xs[1];
		const nodeW = input.nodeWidths[1];
		const nodeY = r.ys[1];
		const nodeH = input.nodeHeights[1];

		expect(selfLoopPoly[0].y).toBeCloseTo(nodeY + nodeH, 0);
		expect(selfLoopPoly[5].y).toBeCloseTo(nodeY, 0);

		expect(selfLoopPoly[2].x).toBeGreaterThan(nodeX + nodeW - 1);
		expect(selfLoopPoly[3].x).toBeGreaterThan(nodeX + nodeW - 1);
	});

	it("padding affects layout dimensions for self-loop nodes", () => {
		const inputNoSelfLoop = makeInput(2, [{ src: 0, dst: 1 }]);
		const rNoSelfLoop = sugiyamaLayout(inputNoSelfLoop);

		const inputWithSelfLoop = makeInput(2, [
			{ src: 0, dst: 0 },
			{ src: 0, dst: 1 },
		]);
		const rWithSelfLoop = sugiyamaLayout(inputWithSelfLoop);

		assertAllFinite(rWithSelfLoop.xs, rWithSelfLoop.ys);
		assertAllFinite(rNoSelfLoop.xs, rNoSelfLoop.ys);
	});

	it("self-loop padding does not change inter-layer node y placement", () => {
		const inputNoSelfLoop = makeInput(2, [{ src: 0, dst: 1 }]);
		const rNoSelfLoop = sugiyamaLayout(inputNoSelfLoop);

		const inputWithSelfLoop = makeInput(2, [
			{ src: 0, dst: 0 },
			{ src: 0, dst: 1 },
		]);
		const rWithSelfLoop = sugiyamaLayout(inputWithSelfLoop);

		expect(rWithSelfLoop.ys[1]).toBeCloseTo(rNoSelfLoop.ys[1], 6);
	});

	it("back edges near layer 0 work correctly without clamping", () => {
		const input = makeInput(4, [
			{ src: 0, dst: 1 },
			{ src: 1, dst: 2 },
			{ src: 2, dst: 3 },
			{ src: 3, dst: 0 },
		]);
		const r = sugiyamaLayout(input);
		assertAllFinite(r.xs, r.ys);
		for (let i = 0; i < 4; i++) assertEdgeConnectsNodes(input, r, i);

		const backEdge = r.edgePolylines[3];
		expect(backEdge.length).toBeGreaterThanOrEqual(4);
		for (const pt of backEdge) {
			expect(Number.isFinite(pt.x)).toBe(true);
			expect(Number.isFinite(pt.y)).toBe(true);
		}
	});

	it("result includes ioWaypoints map", () => {
		const input = makeInput(2, [{ src: 0, dst: 1 }]);
		const r = sugiyamaLayout(input);
		expect(r.ioWaypoints).toBeInstanceOf(Map);
	});
});

describe("VEIL layout", () => {
	beforeEach(() => {
		veilConfig.enabled = true;
	});
	afterEach(() => {
		veilConfig.enabled = false;
	});

	function makeVeilInput(
		nodeCount: number,
		edges: { src: number; dst: number }[],
		widths?: number[],
		heights?: number[],
		root = 0,
	): SugiyamaInput {
		const w = widths ?? new Array(nodeCount).fill(100);
		const h = heights ?? new Array(nodeCount).fill(40);
		const analysis = computeCfgAnalysis(nodeCount, edges, root);
		return {
			nodeCount,
			edges,
			nodeWidths: new Float64Array(w),
			nodeHeights: new Float64Array(h),
			root,
			cfgAnalysis: analysis,
		};
	}

	it("simple chain produces valid layout", () => {
		const input = makeVeilInput(4, [
			{ src: 0, dst: 1 },
			{ src: 1, dst: 2 },
			{ src: 2, dst: 3 },
		]);
		const r = sugiyamaLayout(input);
		assertAllFinite(r.xs, r.ys);
		assertNonNegativePositions(r.xs, r.ys);
		for (let i = 0; i < 3; i++) assertEdgeConnectsNodes(input, r, i);
	});

	it("simple loop: exit node below loop body", () => {
		const input = makeVeilInput(4, [
			{ src: 0, dst: 1 },
			{ src: 1, dst: 2 },
			{ src: 2, dst: 1 },
			{ src: 2, dst: 3 },
		]);
		const r = sugiyamaLayout(input);
		assertAllFinite(r.xs, r.ys);
		assertNonNegativePositions(r.xs, r.ys);
		for (let i = 0; i < 4; i++) assertEdgeConnectsNodes(input, r, i);

		expect(r.ys[3]).toBeGreaterThan(r.ys[1]);
		expect(r.ys[3]).toBeGreaterThan(r.ys[2]);
	});

	it("if-then-else: merge below split", () => {
		const input = makeVeilInput(4, [
			{ src: 0, dst: 1 },
			{ src: 0, dst: 2 },
			{ src: 1, dst: 3 },
			{ src: 2, dst: 3 },
		]);
		const r = sugiyamaLayout(input);
		assertAllFinite(r.xs, r.ys);
		assertNonNegativePositions(r.xs, r.ys);
		for (let i = 0; i < 4; i++) assertEdgeConnectsNodes(input, r, i);

		expect(r.ys[3]).toBeGreaterThan(r.ys[0]);
		expect(r.ys[3]).toBeGreaterThan(r.ys[1]);
		expect(r.ys[3]).toBeGreaterThan(r.ys[2]);
	});

	it("cfgAnalysis correctly classifies back edges", () => {
		const edges = [
			{ src: 0, dst: 1 },
			{ src: 1, dst: 2 },
			{ src: 2, dst: 1 },
			{ src: 2, dst: 3 },
		];
		const analysis = computeCfgAnalysis(4, edges, 0);
		expect(analysis.backEdges[0]).toBe(0);
		expect(analysis.backEdges[1]).toBe(0);
		expect(analysis.backEdges[2]).toBe(1);
		expect(analysis.backEdges[3]).toBe(0);
	});

	it("flag toggle: both modes produce valid layouts", () => {
		const edges = [
			{ src: 0, dst: 1 },
			{ src: 1, dst: 2 },
			{ src: 2, dst: 0 },
			{ src: 1, dst: 3 },
		];
		const veilInput = makeVeilInput(4, edges);
		const rVeil = sugiyamaLayout(veilInput);
		assertAllFinite(rVeil.xs, rVeil.ys);

		veilConfig.enabled = false;
		const plainInput = makeInput(4, edges);
		const rPlain = sugiyamaLayout(plainInput);
		assertAllFinite(rPlain.xs, rPlain.ys);
	});

	it("complex CFG produces valid layout", () => {
		const edges = [
			{ src: 0, dst: 1 },
			{ src: 1, dst: 2 },
			{ src: 1, dst: 5 },
			{ src: 2, dst: 3 },
			{ src: 2, dst: 4 },
			{ src: 3, dst: 5 },
			{ src: 4, dst: 5 },
			{ src: 5, dst: 6 },
			{ src: 6, dst: 1 },
			{ src: 6, dst: 7 },
		];
		const input = makeVeilInput(8, edges);
		const r = sugiyamaLayout(input);
		assertAllFinite(r.xs, r.ys);
		assertNonNegativePositions(r.xs, r.ys);
		assertNoOverlaps(input, r.xs, r.ys);
		for (let i = 0; i < edges.length; i++) assertEdgeConnectsNodes(input, r, i);
	});

	it("empty graph with VEIL", () => {
		const input = makeVeilInput(0, []);
		const r = sugiyamaLayout(input);
		expect(r.xs.length).toBe(0);
	});

	it("single node with VEIL", () => {
		const input = makeVeilInput(1, []);
		const r = sugiyamaLayout(input);
		expect(r.xs.length).toBe(1);
	});
});
