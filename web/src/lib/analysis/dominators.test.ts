import { describe, expect, it } from "bun:test";
import {
	buildDominatorTree,
	computeDominators,
	dominatorDepth,
} from "./dominators";
import { MutableGraph, UNDEFINED } from "./graph";

describe("computeDominators", () => {
	it("single node", () => {
		const g = MutableGraph.fromEdges(1, []);
		const idom = computeDominators(g, 0);
		expect(idom[0]).toBe(0);
	});

	it("chain", () => {
		const g = MutableGraph.fromEdges(4, [
			[0, 1],
			[1, 2],
			[2, 3],
		]);
		const idom = computeDominators(g, 0);
		expect(idom[0]).toBe(0);
		expect(idom[1]).toBe(0);
		expect(idom[2]).toBe(1);
		expect(idom[3]).toBe(2);
	});

	it("diamond", () => {
		const g = MutableGraph.fromEdges(4, [
			[0, 1],
			[0, 2],
			[1, 3],
			[2, 3],
		]);
		const idom = computeDominators(g, 0);
		expect(idom[0]).toBe(0);
		expect(idom[1]).toBe(0);
		expect(idom[2]).toBe(0);
		expect(idom[3]).toBe(0);
	});

	it("if-then-else (same as diamond)", () => {
		const g = MutableGraph.fromEdges(4, [
			[0, 1],
			[0, 2],
			[1, 3],
			[2, 3],
		]);
		const idom = computeDominators(g, 0);
		expect(idom[3]).toBe(0);
	});

	it("nested if", () => {
		const g = MutableGraph.fromEdges(6, [
			[0, 1],
			[0, 2],
			[1, 3],
			[1, 4],
			[3, 5],
			[4, 5],
			[2, 5],
		]);
		const idom = computeDominators(g, 0);
		expect(idom[0]).toBe(0);
		expect(idom[1]).toBe(0);
		expect(idom[2]).toBe(0);
		expect(idom[3]).toBe(1);
		expect(idom[4]).toBe(1);
		expect(idom[5]).toBe(0);
	});

	it("loop with back edge", () => {
		const g = MutableGraph.fromEdges(4, [
			[0, 1],
			[1, 2],
			[2, 1],
			[2, 3],
		]);
		const idom = computeDominators(g, 0);
		expect(idom[0]).toBe(0);
		expect(idom[1]).toBe(0);
		expect(idom[2]).toBe(1);
		expect(idom[3]).toBe(2);
	});

	it("Lengauer-Tarjan paper Figure 1", () => {
		const R = 0,
			A = 1,
			B = 2,
			C = 3,
			D = 4,
			E = 5,
			F = 6,
			G = 7,
			H = 8,
			I = 9,
			J = 10,
			K = 11,
			L = 12;
		const g = MutableGraph.fromEdges(13, [
			[R, A],
			[R, B],
			[R, C],
			[A, D],
			[B, A],
			[B, D],
			[B, E],
			[C, F],
			[C, G],
			[D, L],
			[E, H],
			[F, I],
			[G, I],
			[G, J],
			[H, E],
			[H, K],
			[I, K],
			[J, I],
			[K, R],
			[K, I],
			[L, H],
		]);
		const idom = computeDominators(g, R);
		expect(idom[R]).toBe(R);
		expect(idom[A]).toBe(R);
		expect(idom[B]).toBe(R);
		expect(idom[C]).toBe(R);
		expect(idom[D]).toBe(R);
		expect(idom[E]).toBe(R);
		expect(idom[F]).toBe(C);
		expect(idom[G]).toBe(C);
		expect(idom[H]).toBe(R);
		expect(idom[I]).toBe(R);
		expect(idom[J]).toBe(G);
		expect(idom[K]).toBe(R);
		expect(idom[L]).toBe(D);
	});

	it("unreachable node", () => {
		const g = MutableGraph.fromEdges(3, [[0, 1]]);
		const idom = computeDominators(g, 0);
		expect(idom[0]).toBe(0);
		expect(idom[1]).toBe(0);
		expect(idom[2]).toBe(UNDEFINED);
	});

	it("large chain (1000 nodes)", () => {
		const n = 1000;
		const edges: [number, number][] = [];
		for (let i = 0; i < n - 1; i++) edges.push([i, i + 1]);
		const g = MutableGraph.fromEdges(n, edges);
		const idom = computeDominators(g, 0);
		expect(idom[0]).toBe(0);
		for (let i = 1; i < n; i++) {
			expect(idom[i]).toBe(i - 1);
		}
	});

	it("fan-in", () => {
		const g = MutableGraph.fromEdges(5, [
			[0, 1],
			[0, 2],
			[0, 3],
			[1, 4],
			[2, 4],
			[3, 4],
		]);
		const idom = computeDominators(g, 0);
		expect(idom[0]).toBe(0);
		expect(idom[1]).toBe(0);
		expect(idom[2]).toBe(0);
		expect(idom[3]).toBe(0);
		expect(idom[4]).toBe(0);
	});
});

describe("buildDominatorTree", () => {
	it("produces correct children", () => {
		const g = MutableGraph.fromEdges(4, [
			[0, 1],
			[0, 2],
			[1, 3],
			[2, 3],
		]);
		const idom = computeDominators(g, 0);
		const children = buildDominatorTree(idom, 0);

		expect(children[0]?.length).toBe(3);
		const rootKids = Array.from(children[0]).sort();
		expect(rootKids).toEqual([1, 2, 3]);
		expect(children[1]?.length).toBe(0);
		expect(children[2]?.length).toBe(0);
		expect(children[3]?.length).toBe(0);
	});
});

describe("dominatorDepth", () => {
	it("computes depths for chain", () => {
		const g = MutableGraph.fromEdges(4, [
			[0, 1],
			[1, 2],
			[2, 3],
		]);
		const idom = computeDominators(g, 0);
		const depth = dominatorDepth(idom, 0);
		expect(depth[0]).toBe(0);
		expect(depth[1]).toBe(1);
		expect(depth[2]).toBe(2);
		expect(depth[3]).toBe(3);
	});

	it("unreachable nodes have UNDEFINED depth", () => {
		const g = MutableGraph.fromEdges(3, [[0, 1]]);
		const idom = computeDominators(g, 0);
		const depth = dominatorDepth(idom, 0);
		expect(depth[0]).toBe(0);
		expect(depth[1]).toBe(1);
		expect(depth[2]).toBe(UNDEFINED);
	});
});
