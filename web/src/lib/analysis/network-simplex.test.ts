import { describe, expect, it } from "bun:test";
import { networkSimplex } from "./network-simplex";

function makeGraph(
	nodeCount: number,
	edges: [number, number][],
): { succs: number[][]; preds: number[][] } {
	const succs: number[][] = Array.from({ length: nodeCount }, () => []);
	const preds: number[][] = Array.from({ length: nodeCount }, () => []);
	for (const [src, dst] of edges) {
		succs[src].push(dst);
		preds[dst].push(src);
	}
	return { succs, preds };
}

describe("networkSimplex", () => {
	it("handles empty graph", () => {
		const result = networkSimplex(0, [], []);
		expect(result.layers.length).toBe(0);
		expect(result.layerCount).toBe(0);
	});

	it("handles single node", () => {
		const { succs, preds } = makeGraph(1, []);
		const result = networkSimplex(1, succs, preds);
		expect(result.layers[0]).toBe(1);
		expect(result.layerCount).toBeGreaterThanOrEqual(1);
	});

	it("handles linear chain A->B->C", () => {
		const { succs, preds } = makeGraph(3, [
			[0, 1],
			[1, 2],
		]);
		const result = networkSimplex(3, succs, preds);

		expect(result.layers[0]).toBeGreaterThan(result.layers[1]);
		expect(result.layers[1]).toBeGreaterThan(result.layers[2]);
	});

	it("handles diamond graph", () => {
		const { succs, preds } = makeGraph(4, [
			[0, 1],
			[0, 2],
			[1, 3],
			[2, 3],
		]);
		const result = networkSimplex(4, succs, preds);

		for (const [src, dst] of [
			[0, 1],
			[0, 2],
			[1, 3],
			[2, 3],
		]) {
			expect(result.layers[src]).toBeGreaterThan(result.layers[dst]);
		}

		expect(result.layers[1]).toBe(result.layers[2]);
	});

	it("produces correct layer count", () => {
		const { succs, preds } = makeGraph(3, [
			[0, 1],
			[1, 2],
		]);
		const result = networkSimplex(3, succs, preds);

		let maxLayer = 0;
		for (let i = 0; i < result.layers.length; i++) {
			if (result.layers[i] > maxLayer) maxLayer = result.layers[i];
		}
		expect(result.layerCount).toBe(maxLayer + 1);
	});

	it("all edges point from lower to higher layer", () => {
		const edges: [number, number][] = [
			[0, 1],
			[0, 2],
			[1, 3],
			[2, 3],
			[3, 4],
		];
		const { succs, preds } = makeGraph(5, edges);
		const result = networkSimplex(5, succs, preds);

		for (const [src, dst] of edges) {
			expect(result.layers[src]).toBeGreaterThan(result.layers[dst]);
		}
	});

	it("handles DAG with multiple roots", () => {
		const edges: [number, number][] = [
			[0, 2],
			[1, 2],
			[2, 3],
		];
		const { succs, preds } = makeGraph(4, edges);
		const result = networkSimplex(4, succs, preds);

		for (const [src, dst] of edges) {
			expect(result.layers[src]).toBeGreaterThan(result.layers[dst]);
		}
	});

	it("handles wider DAG", () => {
		const edges: [number, number][] = [
			[0, 1],
			[0, 2],
			[0, 3],
			[1, 4],
			[2, 4],
			[3, 5],
			[4, 5],
		];
		const { succs, preds } = makeGraph(6, edges);
		const result = networkSimplex(6, succs, preds);

		for (const [src, dst] of edges) {
			expect(result.layers[src]).toBeGreaterThan(result.layers[dst]);
		}
	});
});
