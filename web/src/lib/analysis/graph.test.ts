import { describe, expect, it } from "bun:test";
import {
	BitSet,
	type DiGraph,
	DiGraphBuilder,
	EdgeAttr,
	MutableGraph,
	NodeAttr,
	SubGraph,
} from "./graph";

function buildChain(n: number): DiGraph {
	const b = new DiGraphBuilder();
	for (let i = 0; i < n; i++) b.addNode();
	for (let i = 0; i < n - 1; i++) b.addEdge(i, i + 1);
	return b.build();
}

function buildDiamond(): DiGraph {
	const b = new DiGraphBuilder();
	for (let i = 0; i < 4; i++) b.addNode();
	b.addEdge(0, 1);
	b.addEdge(0, 2);
	b.addEdge(1, 3);
	b.addEdge(2, 3);
	return b.build();
}

describe("DiGraphBuilder", () => {
	it("builds an empty graph", () => {
		const g = new DiGraphBuilder().build();
		expect(g.nodeCount).toBe(0);
		expect(g.edgeCount).toBe(0);
	});

	it("builds a single node graph", () => {
		const b = new DiGraphBuilder();
		expect(b.addNode()).toBe(0);
		const g = b.build();
		expect(g.nodeCount).toBe(1);
		expect(g.edgeCount).toBe(0);
		expect(g.successors(0).length).toBe(0);
		expect(g.predecessors(0).length).toBe(0);
	});

	it("builds a single edge graph", () => {
		const b = new DiGraphBuilder();
		b.addNode();
		b.addNode();
		expect(b.addEdge(0, 1)).toBe(0);
		const g = b.build();
		expect(g.nodeCount).toBe(2);
		expect(g.edgeCount).toBe(1);
	});

	it("builds a chain", () => {
		const g = buildChain(5);
		expect(g.nodeCount).toBe(5);
		expect(g.edgeCount).toBe(4);
	});

	it("builds a diamond", () => {
		const g = buildDiamond();
		expect(g.nodeCount).toBe(4);
		expect(g.edgeCount).toBe(4);
	});

	it("builds fan-out", () => {
		const b = new DiGraphBuilder();
		for (let i = 0; i < 5; i++) b.addNode();
		for (let i = 1; i < 5; i++) b.addEdge(0, i);
		const g = b.build();
		expect(g.outDegree(0)).toBe(4);
		for (let i = 1; i < 5; i++) expect(g.inDegree(i)).toBe(1);
	});

	it("builds fan-in", () => {
		const b = new DiGraphBuilder();
		for (let i = 0; i < 5; i++) b.addNode();
		for (let i = 0; i < 4; i++) b.addEdge(i, 4);
		const g = b.build();
		expect(g.inDegree(4)).toBe(4);
		for (let i = 0; i < 4; i++) expect(g.outDegree(i)).toBe(1);
	});
});

describe("DiGraph CSR", () => {
	it("returns correct successor subarray views", () => {
		const g = buildDiamond();
		const s0 = g.successors(0);
		expect(s0.length).toBe(2);
		expect(Array.from(s0).sort()).toEqual([1, 2]);
	});

	it("returns correct predecessor subarray views", () => {
		const g = buildDiamond();
		const p3 = g.predecessors(3);
		expect(p3.length).toBe(2);
		expect(Array.from(p3).sort()).toEqual([1, 2]);
	});

	it("edgeIndex finds existing edges", () => {
		const g = buildDiamond();
		expect(g.edgeIndex(0, 1)).toBeGreaterThanOrEqual(0);
		expect(g.edgeIndex(0, 2)).toBeGreaterThanOrEqual(0);
		expect(g.edgeIndex(1, 3)).toBeGreaterThanOrEqual(0);
		expect(g.edgeIndex(2, 3)).toBeGreaterThanOrEqual(0);
	});

	it("edgeIndex returns -1 for non-existent edges", () => {
		const g = buildDiamond();
		expect(g.edgeIndex(0, 3)).toBe(-1);
		expect(g.edgeIndex(3, 0)).toBe(-1);
		expect(g.edgeIndex(1, 2)).toBe(-1);
	});

	it("edgeSrc and edgeDst are consistent", () => {
		const g = buildDiamond();
		for (let e = 0; e < g.edgeCount; e++) {
			const src = g.edgeSrc(e);
			const dst = g.edgeDst(e);
			expect(g.edgeIndex(src, dst)).toBe(e);
		}
	});

	it("reports correct out/in degree", () => {
		const g = buildDiamond();
		expect(g.outDegree(0)).toBe(2);
		expect(g.outDegree(3)).toBe(0);
		expect(g.inDegree(0)).toBe(0);
		expect(g.inDegree(3)).toBe(2);
	});

	it("successors returns zero-copy subarray view", () => {
		const g = buildChain(3);
		const s = g.successors(0);
		expect(s).toBeInstanceOf(Uint32Array);
		expect(s.buffer).toBe(g.successors(1).buffer);
	});
});

describe("MutableGraph", () => {
	it("adds nodes and edges", () => {
		const mg = new MutableGraph();
		const a = mg.addNode();
		const b = mg.addNode();
		mg.addEdge(a, b);
		expect(mg.nodeCount).toBe(2);
		expect(mg.outDegree(a)).toBe(1);
		expect(mg.inDegree(b)).toBe(1);
		expect(mg.successors(a)).toEqual([b]);
		expect(mg.predecessors(b)).toEqual([a]);
	});

	it("removeEdge removes an existing edge", () => {
		const mg = new MutableGraph();
		mg.addNode();
		mg.addNode();
		mg.addEdge(0, 1);
		expect(mg.removeEdge(0, 1)).toBe(true);
		expect(mg.outDegree(0)).toBe(0);
		expect(mg.inDegree(1)).toBe(0);
	});

	it("removeEdge returns false for non-existent edge", () => {
		const mg = new MutableGraph();
		mg.addNode();
		mg.addNode();
		expect(mg.removeEdge(0, 1)).toBe(false);
	});

	it("reverseEdge flips direction", () => {
		const mg = new MutableGraph();
		mg.addNode();
		mg.addNode();
		mg.addEdge(0, 1);
		mg.reverseEdge(0, 1);
		expect(mg.outDegree(0)).toBe(0);
		expect(mg.inDegree(0)).toBe(1);
		expect(mg.outDegree(1)).toBe(1);
		expect(mg.inDegree(1)).toBe(0);
		expect(mg.successors(1)).toEqual([0]);
	});

	it("fromDiGraph produces equivalent mutable graph", () => {
		const g = buildDiamond();
		const mg = MutableGraph.fromDiGraph(g);
		expect(mg.nodeCount).toBe(g.nodeCount);

		for (let n = 0; n < g.nodeCount; n++) {
			expect(mg.outDegree(n)).toBe(g.outDegree(n));
			expect(mg.inDegree(n)).toBe(g.inDegree(n));

			const gSuccs = Array.from(g.successors(n)).sort() as number[];
			const mgSuccs = Array.from(mg.successors(n)).sort() as number[];
			expect(mgSuccs).toEqual(gSuccs);

			const gPreds = Array.from(g.predecessors(n)).sort() as number[];
			const mgPreds = Array.from(mg.predecessors(n)).sort() as number[];
			expect(mgPreds).toEqual(gPreds);
		}
	});
});

describe("BitSet", () => {
	it("set and has", () => {
		const bs = new BitSet(100);
		bs.set(0);
		bs.set(50);
		bs.set(99);
		expect(bs.has(0)).toBe(true);
		expect(bs.has(50)).toBe(true);
		expect(bs.has(99)).toBe(true);
		expect(bs.has(1)).toBe(false);
		expect(bs.has(51)).toBe(false);
	});

	it("clear removes a bit", () => {
		const bs = new BitSet(64);
		bs.set(10);
		expect(bs.has(10)).toBe(true);
		bs.clear(10);
		expect(bs.has(10)).toBe(false);
	});

	it("toggle flips a bit", () => {
		const bs = new BitSet(64);
		bs.toggle(5);
		expect(bs.has(5)).toBe(true);
		bs.toggle(5);
		expect(bs.has(5)).toBe(false);
	});

	it("forEach iterates set bits", () => {
		const bs = new BitSet(100);
		const expected = [0, 7, 31, 32, 63, 64, 99];
		for (const i of expected) bs.set(i);
		const collected: number[] = [];
		bs.forEach((i) => {
			collected.push(i);
		});
		expect(collected.sort((a, b) => a - b)).toEqual(expected);
	});

	it("count returns popcount", () => {
		const bs = new BitSet(128);
		expect(bs.count()).toBe(0);
		bs.set(0);
		bs.set(31);
		bs.set(32);
		bs.set(127);
		expect(bs.count()).toBe(4);
	});

	it("clone produces independent copy", () => {
		const bs = new BitSet(64);
		bs.set(10);
		const clone = bs.clone();
		clone.clear(10);
		expect(bs.has(10)).toBe(true);
		expect(clone.has(10)).toBe(false);
	});

	it("reset clears all bits", () => {
		const bs = new BitSet(128);
		for (let i = 0; i < 128; i++) bs.set(i);
		expect(bs.count()).toBe(128);
		bs.reset();
		expect(bs.count()).toBe(0);
	});

	it("handles word boundaries correctly", () => {
		const bs = new BitSet(64);
		bs.set(0);
		bs.set(31);
		bs.set(32);
		expect(bs.has(0)).toBe(true);
		expect(bs.has(31)).toBe(true);
		expect(bs.has(32)).toBe(true);
		expect(bs.has(30)).toBe(false);
		expect(bs.has(33)).toBe(false);
	});
});

describe("NodeAttr", () => {
	it("get returns default value", () => {
		const attr = new NodeAttr<number>(5, 42);
		for (let i = 0; i < 5; i++) expect(attr.get(i)).toBe(42);
	});

	it("set and get", () => {
		const attr = new NodeAttr<string>(3, "");
		attr.set(1, "hello");
		expect(attr.get(0)).toBe("");
		expect(attr.get(1)).toBe("hello");
	});

	it("fill overwrites all values", () => {
		const attr = new NodeAttr<number>(3, 0);
		attr.set(0, 10);
		attr.fill(99);
		for (let i = 0; i < 3; i++) expect(attr.get(i)).toBe(99);
	});

	it("resize extends with default value", () => {
		const attr = new NodeAttr<number>(2, 0);
		attr.set(0, 5);
		attr.set(1, 10);
		attr.resize(4, -1);
		expect(attr.get(0)).toBe(5);
		expect(attr.get(1)).toBe(10);
		expect(attr.get(2)).toBe(-1);
		expect(attr.get(3)).toBe(-1);
	});

	it("EdgeAttr is the same class", () => {
		expect(EdgeAttr).toBe(NodeAttr);
	});
});

describe("SubGraph", () => {
	it("constructs from diamond with subset", () => {
		const g = buildDiamond();
		const sg = new SubGraph(g, [0, 1, 3]);
		expect(sg.nodeCount).toBe(3);
	});

	it("local-global mapping is correct", () => {
		const g = buildDiamond();
		const sg = new SubGraph(g, [0, 1, 3]);
		expect(sg.localToGlobal(0)).toBe(0);
		expect(sg.localToGlobal(1)).toBe(1);
		expect(sg.localToGlobal(2)).toBe(3);
		expect(sg.globalToLocal(0)).toBe(0);
		expect(sg.globalToLocal(1)).toBe(1);
		expect(sg.globalToLocal(2)).toBe(-1);
		expect(sg.globalToLocal(3)).toBe(2);
	});

	it("only includes edges within subset", () => {
		const g = buildDiamond();
		const sg = new SubGraph(g, [0, 1, 3]);
		expect(sg.successors(0)).toEqual([1]);
		expect(sg.successors(1)).toEqual([2]);
		expect(sg.predecessors(2)).toEqual([1]);
	});

	it("globalToLocal returns -1 for out of range", () => {
		const g = buildDiamond();
		const sg = new SubGraph(g, [0, 1]);
		expect(sg.globalToLocal(-1)).toBe(-1);
		expect(sg.globalToLocal(999)).toBe(-1);
	});

	it("toMutableGraph returns mutable copy", () => {
		const g = buildDiamond();
		const sg = new SubGraph(g, [0, 1, 2, 3]);
		const mg = sg.toMutableGraph();
		expect(mg.nodeCount).toBe(4);
		expect(mg.outDegree(0)).toBe(2);
		mg.removeEdge(0, 1);
		expect(mg.outDegree(0)).toBe(1);
		expect(sg.successors(0).length).toBe(1);
	});
});
