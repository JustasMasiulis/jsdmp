import { describe, expect, it } from "bun:test";
import {
	classifyEdges,
	computeEdgeOffsets,
	computeTopologicalOrder,
	type DfsResult,
	dfs,
	EdgeType,
} from "./dfs";
import { MutableGraph, type ReadonlyGraph, UNDEFINED } from "./graph";

function edgeType(
	graph: ReadonlyGraph,
	result: DfsResult,
	src: number,
	dst: number,
): EdgeType {
	const offsets = computeEdgeOffsets(graph);
	const types = classifyEdges(graph, result);
	const succs = graph.successors(src);
	for (let i = 0; i < succs.length; i++) {
		if (succs[i] === dst) return types[offsets[src] + i] as EdgeType;
	}
	throw new Error(`edge ${src}->${dst} not found`);
}

function isValidTopologicalOrder(
	graph: ReadonlyGraph,
	order: Uint32Array,
): boolean {
	const position = new Map<number, number>();
	for (let i = 0; i < order.length; i++) {
		position.set(order[i], i);
	}
	for (let u = 0; u < graph.nodeCount; u++) {
		const succs = graph.successors(u);
		for (let j = 0; j < succs.length; j++) {
			const v = succs[j];
			if (position.get(u) > position.get(v)) return false;
		}
	}
	return true;
}

describe("dfs", () => {
	it("handles a chain graph", () => {
		const g = MutableGraph.fromEdges(4, [
			[0, 1],
			[1, 2],
			[2, 3],
		]);
		const r = dfs(g, 0);

		expect(Array.from(r.preOrder)).toEqual([0, 1, 2, 3]);
		expect(Array.from(r.postOrder)).toEqual([3, 2, 1, 0]);
		expect(r.parent[0]).toBe(UNDEFINED);
		expect(r.parent[1]).toBe(0);
		expect(r.parent[2]).toBe(1);
		expect(r.parent[3]).toBe(2);
	});

	it("handles a diamond graph", () => {
		const g = MutableGraph.fromEdges(4, [
			[0, 1],
			[0, 2],
			[1, 3],
			[2, 3],
		]);
		const r = dfs(g, 0);

		expect(r.preNum[0]).toBe(0);
		expect(r.preOrder[0]).toBe(0);

		for (let i = 0; i < 4; i++) {
			expect(r.preNum[i]).not.toBe(UNDEFINED);
			expect(r.postNum[i]).not.toBe(UNDEFINED);
		}

		const type_0_1 = edgeType(g, r, 0, 1);
		const type_1_3 = edgeType(g, r, 1, 3);
		expect(type_0_1).toBe(EdgeType.TREE);
		expect(type_1_3).toBe(EdgeType.TREE);

		const type_0_2 = edgeType(g, r, 0, 2);
		const type_2_3 = edgeType(g, r, 2, 3);

		if (r.parent[2] === 0) {
			expect(type_0_2).toBe(EdgeType.TREE);
			expect(type_2_3).toBe(EdgeType.CROSS);
		} else {
			expect(type_0_2).toBe(EdgeType.FORWARD);
		}
	});

	it("handles a loop", () => {
		const g = MutableGraph.fromEdges(3, [
			[0, 1],
			[1, 2],
			[2, 0],
		]);
		const r = dfs(g, 0);

		expect(Array.from(r.preOrder)).toEqual([0, 1, 2]);
		expect(edgeType(g, r, 0, 1)).toBe(EdgeType.TREE);
		expect(edgeType(g, r, 1, 2)).toBe(EdgeType.TREE);
		expect(edgeType(g, r, 2, 0)).toBe(EdgeType.BACK);
	});

	it("handles a self-loop", () => {
		const g = MutableGraph.fromEdges(1, [[0, 0]]);
		const r = dfs(g, 0);

		expect(r.preOrder[0]).toBe(0);
		expect(r.postOrder[0]).toBe(0);
		expect(edgeType(g, r, 0, 0)).toBe(EdgeType.BACK);
	});

	it("classifies only the first parallel discovery edge as tree", () => {
		const g = MutableGraph.fromEdges(2, [
			[0, 1],
			[0, 1],
		]);
		const r = dfs(g, 0);
		const offsets = computeEdgeOffsets(g);
		const types = classifyEdges(g, r);

		expect(types[offsets[0] + 0]).toBe(EdgeType.TREE);
		expect(types[offsets[0] + 1]).toBe(EdgeType.FORWARD);
	});

	it("handles disconnected components", () => {
		const g = MutableGraph.fromEdges(4, [
			[0, 1],
			[2, 3],
		]);
		const r = dfs(g, 0);

		expect(r.visitedCount).toBe(2);
		expect(r.preNum[0]).not.toBe(UNDEFINED);
		expect(r.preNum[1]).not.toBe(UNDEFINED);
		expect(r.postNum[0]).not.toBe(UNDEFINED);
		expect(r.postNum[1]).not.toBe(UNDEFINED);
		expect(r.preNum[2]).toBe(UNDEFINED);
		expect(r.preNum[3]).toBe(UNDEFINED);
		expect(r.postNum[2]).toBe(UNDEFINED);
		expect(r.postNum[3]).toBe(UNDEFINED);

		expect(r.parent[0]).toBe(UNDEFINED);
		expect(r.parent[1]).toBe(0);
		expect(r.parent[2]).toBe(UNDEFINED);
		expect(r.parent[3]).toBe(UNDEFINED);

		expect(edgeType(g, r, 2, 3)).toBe(EdgeType.NONE);
	});

	it("handles a binary tree", () => {
		const g = MutableGraph.fromEdges(7, [
			[0, 1],
			[0, 2],
			[1, 3],
			[1, 4],
			[2, 5],
			[2, 6],
		]);
		const r = dfs(g, 0);
		const types = classifyEdges(g, r);

		for (let i = 0; i < types.length; i++) {
			expect(types[i]).toBe(EdgeType.TREE);
		}
	});

	it("handles a complex CFG with mixed edge types", () => {
		const g = MutableGraph.fromEdges(6, [
			[0, 1],
			[0, 2],
			[1, 3],
			[2, 3],
			[3, 4],
			[4, 1],
			[3, 5],
		]);
		const r = dfs(g, 0);

		expect(edgeType(g, r, 0, 1)).toBe(EdgeType.TREE);
		expect(edgeType(g, r, 1, 3)).toBe(EdgeType.TREE);
		expect(edgeType(g, r, 4, 1)).toBe(EdgeType.BACK);
	});

	it("computes valid topological order for a DAG", () => {
		const g = MutableGraph.fromEdges(6, [
			[0, 1],
			[0, 2],
			[1, 3],
			[2, 3],
			[3, 4],
			[3, 5],
		]);
		const topo = computeTopologicalOrder(g, 0);

		expect(topo.length).toBe(6);
		expect(isValidTopologicalOrder(g, topo)).toBe(true);
		expect(topo[0]).toBe(0);
	});

	it("handles a large chain without stack overflow", () => {
		const NODE_COUNT = 10000;
		const edges: [number, number][] = [];
		for (let i = 0; i < NODE_COUNT - 1; i++) {
			edges.push([i, i + 1]);
		}
		const g = MutableGraph.fromEdges(NODE_COUNT, edges);
		const r = dfs(g, 0);

		expect(r.preOrder[0]).toBe(0);
		expect(r.preOrder[NODE_COUNT - 1]).toBe(NODE_COUNT - 1);
		expect(r.postOrder[0]).toBe(NODE_COUNT - 1);
		expect(r.postOrder[NODE_COUNT - 1]).toBe(0);

		for (let i = 0; i < NODE_COUNT; i++) {
			expect(r.preNum[i]).toBe(i);
			expect(r.postNum[i]).toBe(NODE_COUNT - 1 - i);
		}
	});

	it("handles an empty graph", () => {
		const g = MutableGraph.fromEdges(0, []);
		const r = dfs(g, 0);

		expect(r.preOrder.length).toBe(0);
		expect(r.postOrder.length).toBe(0);
	});

	it("edge offsets are cumulative out-degree prefix sums", () => {
		const g = MutableGraph.fromEdges(4, [
			[0, 1],
			[0, 2],
			[1, 3],
			[2, 3],
		]);
		const offsets = computeEdgeOffsets(g);

		expect(offsets[0]).toBe(0);
		expect(offsets[1]).toBe(2);
		expect(offsets[2]).toBe(3);
		expect(offsets[3]).toBe(4);
		expect(offsets[4]).toBe(4);
	});
});
