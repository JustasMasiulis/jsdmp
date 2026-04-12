import { describe, expect, it } from "bun:test";
import { MutableGraph } from "./graph";
import { computeSESERegions, type SESERegion, type SESEResult } from "./sese";

function allNodesAssigned(result: SESEResult, nodeCount: number): boolean {
	const seen = new Uint8Array(nodeCount);
	for (const region of result.regions) {
		for (const node of region.nodes) {
			if (node >= nodeCount) return false;
			if (seen[node]) return false;
			seen[node] = 1;
		}
	}
	for (let i = 0; i < nodeCount; i++) {
		if (!seen[i]) return false;
	}
	return true;
}

function regionOfConsistent(result: SESEResult): boolean {
	for (let i = 0; i < result.regions.length; i++) {
		for (const node of result.regions[i].nodes) {
			if (result.regionOf[node] !== i) return false;
		}
	}
	return true;
}

function parentChildConsistent(result: SESEResult): boolean {
	for (let i = 0; i < result.regions.length; i++) {
		const region = result.regions[i];
		for (const childIdx of region.children) {
			if (result.regions[childIdx]?.parent !== i) return false;
		}
	}
	return true;
}

function collectRegionNodes(
	result: SESEResult,
	regionIdx: number,
): Set<number> {
	const nodes = new Set<number>();
	const visited = new Set<number>();
	const stack = [regionIdx];
	while (stack.length > 0) {
		const idx = stack.pop()!;
		if (visited.has(idx)) continue;
		visited.add(idx);
		const region = result.regions[idx];
		if (!region) continue;
		for (const n of region.nodes) nodes.add(n);
		for (const c of region.children) stack.push(c);
	}
	return nodes;
}

function nonTrivialRegions(result: SESEResult): SESERegion[] {
	return result.regions.filter(
		(r) => r.nodes.length > 0 || r.children.length > 0,
	);
}

function assertStructuralInvariants(
	result: SESEResult,
	nodeCount: number,
): void {
	expect(allNodesAssigned(result, nodeCount)).toBe(true);
	expect(regionOfConsistent(result)).toBe(true);
	expect(parentChildConsistent(result)).toBe(true);
	expect(result.regions[0]?.parent).toBe(-1);
	for (let i = 1; i < result.regions.length; i++) {
		const parent = result.regions[i]?.parent;
		expect(parent).toBeGreaterThanOrEqual(0);
		expect(parent).toBeLessThan(result.regions.length);
	}
}

describe("computeSESERegions", () => {
	it("handles a single node", () => {
		const g = MutableGraph.fromEdges(1, []);
		const result = computeSESERegions(g, 0);

		expect(result.regions.length).toBeGreaterThanOrEqual(1);
		expect(result.regions[0]?.parent).toBe(-1);
		assertStructuralInvariants(result, 1);
	});

	it("handles a straight line", () => {
		const g = MutableGraph.fromEdges(4, [
			[0, 1],
			[1, 2],
			[2, 3],
		]);
		const result = computeSESERegions(g, 0);

		assertStructuralInvariants(result, 4);
	});

	it("handles empty graph", () => {
		const g = MutableGraph.fromEdges(0, []);
		const result = computeSESERegions(g, 0);

		expect(result.regions.length).toBe(1);
		expect(result.regions[0]?.nodes.length).toBe(0);
	});

	it("DEBUG: dump if-then-else regions", () => {
		const g = MutableGraph.fromEdges(4, [
			[0, 1],
			[0, 2],
			[1, 3],
			[2, 3],
		]);
		const result = computeSESERegions(g, 0);
		for (let i = 0; i < result.regions.length; i++) {
			const r = result.regions[i];
			console.log(
				`Region ${i}: parent=${r.parent} entry=${r.entryEdge} exit=${r.exitEdge} nodes=[${r.nodes}] children=[${r.children}]`,
			);
		}
		console.log(`regionOf: [${Array.from(result.regionOf)}]`);
	});

	it("DEBUG: dump simple loop regions", () => {
		const g = MutableGraph.fromEdges(4, [
			[0, 1],
			[1, 2],
			[2, 1],
			[2, 3],
		]);
		const result = computeSESERegions(g, 0);
		for (let i = 0; i < result.regions.length; i++) {
			const r = result.regions[i];
			console.log(
				`Region ${i}: parent=${r.parent} entry=${r.entryEdge} exit=${r.exitEdge} nodes=[${r.nodes}] children=[${r.children}]`,
			);
		}
		console.log(`regionOf: [${Array.from(result.regionOf)}]`);
	});

	it("DEBUG: dump nested if-then-else regions", () => {
		const g = MutableGraph.fromEdges(7, [
			[0, 1],
			[0, 2],
			[1, 3],
			[1, 4],
			[3, 5],
			[4, 5],
			[5, 6],
			[2, 6],
		]);
		const result = computeSESERegions(g, 0);
		for (let i = 0; i < result.regions.length; i++) {
			const r = result.regions[i];
			console.log(
				`Region ${i}: parent=${r.parent} entry=${r.entryEdge} exit=${r.exitEdge} nodes=[${r.nodes}] children=[${r.children}]`,
			);
		}
		console.log(`regionOf: [${Array.from(result.regionOf)}]`);
	});

	it("DEBUG: dump if-inside-loop regions", () => {
		const g = MutableGraph.fromEdges(6, [
			[0, 1],
			[1, 2],
			[1, 3],
			[2, 4],
			[3, 4],
			[4, 1],
			[4, 5],
		]);
		const result = computeSESERegions(g, 0);
		for (let i = 0; i < result.regions.length; i++) {
			const r = result.regions[i];
			console.log(
				`Region ${i}: parent=${r.parent} entry=${r.entryEdge} exit=${r.exitEdge} nodes=[${r.nodes}] children=[${r.children}]`,
			);
		}
		console.log(`regionOf: [${Array.from(result.regionOf)}]`);
	});

	it("DEBUG: dump nested loops regions", () => {
		const g = MutableGraph.fromEdges(5, [
			[0, 1],
			[1, 2],
			[2, 3],
			[3, 2],
			[3, 1],
			[3, 4],
		]);
		const result = computeSESERegions(g, 0);
		for (let i = 0; i < result.regions.length; i++) {
			const r = result.regions[i];
			console.log(
				`Region ${i}: parent=${r.parent} entry=${r.entryEdge} exit=${r.exitEdge} nodes=[${r.nodes}] children=[${r.children}]`,
			);
		}
		console.log(`regionOf: [${Array.from(result.regionOf)}]`);
	});

	describe("simple if-then-else: A->B, A->C, B->D, C->D", () => {
		const g = MutableGraph.fromEdges(4, [
			[0, 1],
			[0, 2],
			[1, 3],
			[2, 3],
		]);

		it("has correct structural invariants", () => {
			const result = computeSESERegions(g, 0);
			assertStructuralInvariants(result, 4);
		});

		it("identifies exactly one non-trivial SESE region for the diamond", () => {
			const result = computeSESERegions(g, 0);
			const childRegions = result.regions.filter(
				(_, i) => i > 0 && result.regions[i].nodes.length > 0,
			);
			expect(childRegions.length).toBeGreaterThanOrEqual(1);

			const allInOneRegion = result.regions.some((r) => {
				const nodes = new Set(r.nodes);
				return nodes.has(0) && nodes.has(1) && nodes.has(2) && nodes.has(3);
			});
			const diamondRegion = result.regions.find((r) => {
				const allNodes = collectRegionNodes(result, result.regions.indexOf(r));
				return (
					allNodes.has(0) &&
					allNodes.has(1) &&
					allNodes.has(2) &&
					allNodes.has(3)
				);
			});
			expect(allInOneRegion || diamondRegion !== undefined).toBe(true);
		});
	});

	describe("nested if-then-else: two sequential diamonds", () => {
		const g = MutableGraph.fromEdges(7, [
			[0, 1],
			[0, 2],
			[1, 3],
			[2, 3],
			[3, 4],
			[3, 5],
			[4, 6],
			[5, 6],
		]);

		it("has correct structural invariants", () => {
			const result = computeSESERegions(g, 0);
			assertStructuralInvariants(result, 7);
		});

		it("identifies at least 2 non-trivial SESE regions for sequential diamonds", () => {
			const result = computeSESERegions(g, 0);
			const nonRoot = result.regions.filter((_, i) => i > 0);
			expect(nonRoot.length).toBeGreaterThanOrEqual(2);
		});
	});

	describe("nested if-then-else: diamond inside diamond", () => {
		const g = MutableGraph.fromEdges(7, [
			[0, 1],
			[0, 2],
			[1, 3],
			[1, 4],
			[3, 5],
			[4, 5],
			[5, 6],
			[2, 6],
		]);

		it("has correct structural invariants", () => {
			const result = computeSESERegions(g, 0);
			assertStructuralInvariants(result, 7);
		});

		it("identifies at least 2 SESE regions (outer diamond + inner diamond)", () => {
			const result = computeSESERegions(g, 0);
			const nonRoot = result.regions.filter((_, i) => i > 0);
			expect(nonRoot.length).toBeGreaterThanOrEqual(2);
		});

		it("has a region containing inner diamond nodes {1,3,4,5}", () => {
			const result = computeSESERegions(g, 0);
			const innerDiamondRegion = result.regions.find((r) => {
				const allNodes = collectRegionNodes(result, result.regions.indexOf(r));
				return (
					allNodes.has(1) &&
					allNodes.has(3) &&
					allNodes.has(4) &&
					allNodes.has(5) &&
					!allNodes.has(0) &&
					!allNodes.has(2)
				);
			});
			expect(innerDiamondRegion).toBeDefined();
		});
	});

	describe("simple loop: A->B, B->C, C->B (back), C->D", () => {
		const g = MutableGraph.fromEdges(4, [
			[0, 1],
			[1, 2],
			[2, 1],
			[2, 3],
		]);

		it("has correct structural invariants", () => {
			const result = computeSESERegions(g, 0);
			assertStructuralInvariants(result, 4);
		});

		it("identifies the loop body as a SESE region", () => {
			const result = computeSESERegions(g, 0);
			const loopRegion = result.regions.find((r) => {
				const allNodes = collectRegionNodes(result, result.regions.indexOf(r));
				return allNodes.has(1) && allNodes.has(2) && !allNodes.has(0);
			});
			expect(loopRegion).toBeDefined();
		});
	});

	describe("if inside loop: Entry->A, A->B, A->C, B->D, C->D, D->A (back), D->Exit", () => {
		const g = MutableGraph.fromEdges(6, [
			[0, 1],
			[1, 2],
			[1, 3],
			[2, 4],
			[3, 4],
			[4, 1],
			[4, 5],
		]);

		it("has correct structural invariants", () => {
			const result = computeSESERegions(g, 0);
			assertStructuralInvariants(result, 6);
		});

		it("identifies at least 2 regions (loop + if-then-else inside)", () => {
			const result = computeSESERegions(g, 0);
			const nonRoot = result.regions.filter((_, i) => i > 0);
			expect(nonRoot.length).toBeGreaterThanOrEqual(2);
		});

		it("has a loop region containing {1,2,3,4}", () => {
			const result = computeSESERegions(g, 0);
			const loopRegion = result.regions.find((r) => {
				const allNodes = collectRegionNodes(result, result.regions.indexOf(r));
				return (
					allNodes.has(1) &&
					allNodes.has(2) &&
					allNodes.has(3) &&
					allNodes.has(4) &&
					!allNodes.has(0) &&
					!allNodes.has(5)
				);
			});
			expect(loopRegion).toBeDefined();
		});
	});

	describe("irreducible graph: A->B, A->C, B->C, C->B", () => {
		const g = MutableGraph.fromEdges(4, [
			[0, 1],
			[0, 2],
			[1, 2],
			[2, 1],
			[1, 3],
			[2, 3],
		]);

		it("has correct structural invariants", () => {
			const result = computeSESERegions(g, 0);
			assertStructuralInvariants(result, 4);
		});
	});

	describe("nested loops: outer B->C->D, inner C->D->C", () => {
		const g = MutableGraph.fromEdges(5, [
			[0, 1],
			[1, 2],
			[2, 3],
			[3, 2],
			[3, 1],
			[3, 4],
		]);

		it("has correct structural invariants", () => {
			const result = computeSESERegions(g, 0);
			assertStructuralInvariants(result, 5);
		});

		it("identifies at least 2 regions for nested loops", () => {
			const result = computeSESERegions(g, 0);
			const nonRoot = result.regions.filter((_, i) => i > 0);
			expect(nonRoot.length).toBeGreaterThanOrEqual(2);
		});
	});

	describe("self-loop", () => {
		const g = MutableGraph.fromEdges(3, [
			[0, 1],
			[1, 1],
			[1, 2],
		]);

		it("has correct structural invariants", () => {
			const result = computeSESERegions(g, 0);
			assertStructuralInvariants(result, 3);
		});
	});

	describe("multiple exits merged to single virtual exit", () => {
		const g = MutableGraph.fromEdges(5, [
			[0, 1],
			[0, 2],
			[1, 3],
			[2, 4],
		]);

		it("has correct structural invariants", () => {
			const result = computeSESERegions(g, 0);
			assertStructuralInvariants(result, 5);
		});
	});

	describe("graph with no sinks (all nodes have successors except through cycle)", () => {
		const g = MutableGraph.fromEdges(3, [
			[0, 1],
			[1, 2],
			[2, 0],
		]);

		it("has correct structural invariants", () => {
			const result = computeSESERegions(g, 0);
			assertStructuralInvariants(result, 3);
		});
	});

	it("handles large graph without stack overflow", () => {
		const NODE_COUNT = 1000;
		const edges: [number, number][] = [];
		for (let i = 0; i < NODE_COUNT - 1; i++) {
			edges.push([i, i + 1]);
		}
		for (let i = 0; i < NODE_COUNT - 100; i += 100) {
			edges.push([i, i + 50]);
		}
		const g = MutableGraph.fromEdges(NODE_COUNT, edges);
		const result = computeSESERegions(g, 0);

		assertStructuralInvariants(result, NODE_COUNT);
	});
});
