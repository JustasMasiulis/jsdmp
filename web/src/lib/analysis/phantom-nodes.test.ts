import { describe, expect, it } from "bun:test";
import { MutableGraph } from "./graph";
import { createPhantomNodes } from "./phantom-nodes";

function allPredecessorsReach(
	graph: MutableGraph,
	target: number,
	originalPreds: number[],
): boolean {
	for (const pred of originalPreds) {
		if (!canReach(graph, pred, target)) return false;
	}
	return true;
}

function canReach(graph: MutableGraph, from: number, to: number): boolean {
	const visited = new Set<number>();
	const stack = [from];
	while (stack.length > 0) {
		const node = stack.pop()!;
		if (node === to) return true;
		if (visited.has(node)) continue;
		visited.add(node);
		for (const succ of graph.successors(node)) stack.push(succ);
	}
	return false;
}

describe("createPhantomNodes", () => {
	it("no changes for low in-degree graph", () => {
		const g = MutableGraph.fromEdges(4, [
			[0, 1],
			[0, 2],
			[1, 3],
			[2, 3],
		]);
		const originalNodeCount = g.nodeCount;
		const phantomMap = createPhantomNodes(g, 0);
		expect(g.nodeCount).toBe(originalNodeCount);
		expect(phantomMap.size).toBe(0);
	});

	it("single node graph is unchanged", () => {
		const g = MutableGraph.fromEdges(1, []);
		const phantomMap = createPhantomNodes(g, 0);
		expect(g.nodeCount).toBe(1);
		expect(phantomMap.size).toBe(0);
	});

	it("splits node with exactly 3 parents", () => {
		const g = MutableGraph.fromEdges(5, [
			[0, 1],
			[0, 2],
			[0, 3],
			[1, 4],
			[2, 4],
			[3, 4],
		]);

		const phantomMap = createPhantomNodes(g, 0);

		expect(phantomMap.size).toBeGreaterThan(0);
		for (const [, original] of phantomMap) {
			expect(original).toBe(4);
		}

		expect(g.inDegree(4)).toBeLessThan(3);
		expect(allPredecessorsReach(g, 4, [1, 2, 3])).toBe(true);
	});

	it("splits node with many parents via tree of phantoms", () => {
		const parents = [1, 2, 3, 4, 5, 6, 7, 8];
		const target = 9;
		const edges: [number, number][] = [];
		for (const p of parents) {
			edges.push([0, p]);
			edges.push([p, target]);
		}

		const g = MutableGraph.fromEdges(10, edges);
		const phantomMap = createPhantomNodes(g, 0);

		expect(phantomMap.size).toBeGreaterThan(0);
		for (const [, original] of phantomMap) {
			expect(original).toBe(target);
		}

		expect(allPredecessorsReach(g, target, parents)).toBe(true);
	});

	it("preserves connectivity for all original paths", () => {
		const g = MutableGraph.fromEdges(7, [
			[0, 1],
			[0, 2],
			[1, 3],
			[2, 3],
			[1, 4],
			[2, 4],
			[3, 5],
			[4, 5],
			[3, 6],
			[4, 6],
			[0, 6],
		]);

		const originalReachable = new Map<number, Set<number>>();
		for (let n = 0; n < 7; n++) {
			const reachable = new Set<number>();
			const stack = [n];
			while (stack.length > 0) {
				const cur = stack.pop()!;
				if (reachable.has(cur)) continue;
				reachable.add(cur);
				for (const succ of g.successors(cur)) stack.push(succ);
			}
			originalReachable.set(n, reachable);
		}

		createPhantomNodes(g, 0);

		for (const [node, reachable] of originalReachable) {
			for (const target of reachable) {
				expect(canReach(g, node, target)).toBe(true);
			}
		}
	});

	it("root with high in-degree from back edges does not crash", () => {
		const g = MutableGraph.fromEdges(4, [
			[0, 1],
			[0, 2],
			[0, 3],
			[1, 0],
			[2, 0],
			[3, 0],
		]);
		expect(() => createPhantomNodes(g, 0)).not.toThrow();
	});

	it("creates single phantom parent for node with in>1 and out>1", () => {
		const g = MutableGraph.fromEdges(6, [
			[0, 1],
			[0, 2],
			[1, 3],
			[2, 3],
			[3, 4],
			[3, 5],
		]);
		const phantomMap = createPhantomNodes(g, 0);

		expect(g.inDegree(3)).toBe(1);
		expect(phantomMap.size).toBe(1);
		const [phantomNode] = phantomMap.keys();
		expect(phantomMap.get(phantomNode)).toBe(3);
		expect(g.successors(phantomNode)).toEqual([3]);
		expect(g.outDegree(3)).toBe(2);
	});

	it("chain graph is unchanged", () => {
		const g = MutableGraph.fromEdges(5, [
			[0, 1],
			[1, 2],
			[2, 3],
			[3, 4],
		]);
		const phantomMap = createPhantomNodes(g, 0);
		expect(g.nodeCount).toBe(5);
		expect(phantomMap.size).toBe(0);
	});

	it("phantom nodes map to the correct original node", () => {
		const g = MutableGraph.fromEdges(6, [
			[0, 1],
			[0, 2],
			[0, 3],
			[0, 4],
			[1, 5],
			[2, 5],
			[3, 5],
			[4, 5],
		]);

		const phantomMap = createPhantomNodes(g, 0);

		for (const [phantom, original] of phantomMap) {
			expect(phantom).toBeGreaterThanOrEqual(6);
			expect(original).toBe(5);
		}
	});
});
