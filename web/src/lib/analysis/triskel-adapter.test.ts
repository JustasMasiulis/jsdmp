import { describe, expect, it } from "bun:test";
import type { CfgBuildResult, CfgEdge, CfgNode } from "../disassemblyGraph";
import { triskelBuildRenderGraph } from "./triskel-adapter";

function makeBlock(id: string, lineCount = 3): CfgNode {
	const lines = Array.from({ length: lineCount }, (_, i) => ({
		text: `line ${i} of block ${id}`.padEnd(30),
		segments: [
			{
				text: `line ${i} of block ${id}`.padEnd(30),
				clickable: false,
				term: null,
				syntaxKind: "plain" as const,
			},
		],
	}));
	return { id, title: id, instructionCount: lineCount, lines };
}

function makeEdge(
	from: string,
	to: string,
	kind: "true" | "false" | "unconditional" = "unconditional",
): CfgEdge {
	return { id: `${from}->${to}`, from, to, kind };
}

function makeCfgResult(blocks: CfgNode[], edges: CfgEdge[]): CfgBuildResult {
	return {
		anchorAddress: 0n,
		blocks,
		edges,
		stats: {
			blockCount: blocks.length,
			edgeCount: edges.length,
			instructionCount: blocks.reduce((sum, b) => sum + b.instructionCount, 0),
			truncated: false,
		},
	};
}

describe("triskelBuildRenderGraph", () => {
	it("round-trips a minimal graph", () => {
		const graph = triskelBuildRenderGraph(
			makeCfgResult([makeBlock("A"), makeBlock("B")], [makeEdge("A", "B")]),
		);
		expect(graph.nodes.length).toBe(2);
		expect(graph.edges.length).toBe(1);
		expect(graph.nodeMap.has("A")).toBe(true);
		expect(graph.nodeMap.has("B")).toBe(true);
	});

	it("correct edge colors", () => {
		const graph = triskelBuildRenderGraph(
			makeCfgResult(
				[makeBlock("A"), makeBlock("B"), makeBlock("C"), makeBlock("D")],
				[
					makeEdge("A", "B", "true"),
					makeEdge("A", "C", "false"),
					makeEdge("C", "D", "unconditional"),
				],
			),
		);
		const byKey = new Map(graph.edges.map((e) => [e.key, e]));
		expect(byKey.get("A\u2192B")?.color).toBe("#009b5e");
		expect(byKey.get("A\u2192C")?.color).toBe("#f30c00");
		expect(byKey.get("C\u2192D")?.color).toBe("#3575fe");
	});

	it("empty graph", () => {
		const graph = triskelBuildRenderGraph(makeCfgResult([], []));
		expect(graph.nodes.length).toBe(0);
	});

	it("Y-up: root.y > child.y (rendering convention)", () => {
		const graph = triskelBuildRenderGraph(
			makeCfgResult(
				[makeBlock("root"), makeBlock("child")],
				[makeEdge("root", "child")],
			),
		);
		const root = graph.nodeMap.get("root");
		const child = graph.nodeMap.get("child");
		expect(root.y).toBeGreaterThan(child.y);
	});

	it("edge first point near source bottom, last point near dest top", () => {
		const graph = triskelBuildRenderGraph(
			makeCfgResult([makeBlock("A"), makeBlock("B")], [makeEdge("A", "B")]),
		);
		const a = graph.nodeMap.get("A");
		const b = graph.nodeMap.get("B");
		const pts = graph.edges[0].polylinePoints;
		const first = pts[0];
		const last = pts[pts.length - 1];

		expect(first.x).toBeGreaterThanOrEqual(a.x - 1);
		expect(first.x).toBeLessThanOrEqual(a.x + a.width + 1);
		expect(Math.abs(first.y - (a.y - a.height))).toBeLessThan(2);

		expect(last.x).toBeGreaterThanOrEqual(b.x - 1);
		expect(last.x).toBeLessThanOrEqual(b.x + b.width + 1);
		expect(Math.abs(last.y - b.y)).toBeLessThan(2);
	});

	it("bbox: yMin < yMax, encompasses all nodes", () => {
		const graph = triskelBuildRenderGraph(
			makeCfgResult(
				[makeBlock("A"), makeBlock("B"), makeBlock("C")],
				[makeEdge("A", "B"), makeEdge("B", "C")],
			),
		);
		expect(graph.bbox.y[0]).toBeLessThan(graph.bbox.y[1]);
		for (const n of graph.nodes) {
			expect(n.y - n.height).toBeGreaterThanOrEqual(graph.bbox.y[0] - 1);
			expect(n.y).toBeLessThanOrEqual(graph.bbox.y[1] + 1);
		}
	});

	it("edge polylines are orthogonal (only vertical/horizontal segments)", () => {
		const graph = triskelBuildRenderGraph(
			makeCfgResult(
				[makeBlock("A"), makeBlock("B"), makeBlock("C")],
				[makeEdge("A", "B"), makeEdge("A", "C"), makeEdge("B", "C")],
			),
		);
		for (const edge of graph.edges) {
			const pts = edge.polylinePoints;
			for (let i = 1; i < pts.length; i++) {
				const dx = Math.abs(pts[i].x - pts[i - 1].x);
				const dy = Math.abs(pts[i].y - pts[i - 1].y);
				const isHorizontal = dy < 0.5;
				const isVertical = dx < 0.5;
				expect(isHorizontal || isVertical).toBe(true);
			}
		}
	});
});
