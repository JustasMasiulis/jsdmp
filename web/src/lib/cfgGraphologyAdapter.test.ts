import { describe, expect, test } from "bun:test";
import { buildRenderGraph, trimPolylineEnd } from "../rendering/cfgRenderGraph";
import type { CfgBuildResult } from "./disassemblyGraph";
import type { GraphLayoutCore } from "./graph-layout-core";

describe("trimPolylineEnd", () => {
	test("returns original when fewer than 2 points", () => {
		const single = [{ x: 0, y: 0 }];
		expect(trimPolylineEnd(single, 10)).toEqual(single);
		expect(trimPolylineEnd([], 10)).toEqual([]);
	});

	test("returns original when trimDistance is 0 or negative", () => {
		const pts = [
			{ x: 0, y: 0 },
			{ x: 10, y: 0 },
		];
		expect(trimPolylineEnd(pts, 0)).toEqual(pts);
		expect(trimPolylineEnd(pts, -5)).toEqual(pts);
	});

	test("returns original when total length <= trimDistance", () => {
		const pts = [
			{ x: 0, y: 0 },
			{ x: 3, y: 4 },
		];
		expect(trimPolylineEnd(pts, 5)).toEqual(pts);
		expect(trimPolylineEnd(pts, 100)).toEqual(pts);
	});

	test("trims a single segment partially", () => {
		const pts = [
			{ x: 0, y: 0 },
			{ x: 10, y: 0 },
		];
		const result = trimPolylineEnd(pts, 3);
		expect(result).toHaveLength(2);
		expect(result[0]).toEqual({ x: 0, y: 0 });
		expect(result[1].x).toBeCloseTo(7, 10);
		expect(result[1].y).toBeCloseTo(0, 10);
	});

	test("removes entire last segment if it equals trimDistance", () => {
		const pts = [
			{ x: 0, y: 0 },
			{ x: 5, y: 0 },
			{ x: 5, y: 3 },
		];
		const result = trimPolylineEnd(pts, 3);
		expect(result).toEqual([
			{ x: 0, y: 0 },
			{ x: 5, y: 0 },
		]);
	});

	test("removes last segment and trims into preceding one", () => {
		const pts = [
			{ x: 0, y: 0 },
			{ x: 10, y: 0 },
			{ x: 10, y: 4 },
		];
		const result = trimPolylineEnd(pts, 6);
		expect(result).toHaveLength(2);
		expect(result[0]).toEqual({ x: 0, y: 0 });
		expect(result[1].x).toBeCloseTo(8, 10);
		expect(result[1].y).toBeCloseTo(0, 10);
	});

	test("does not mutate input", () => {
		const pts = [
			{ x: 0, y: 0 },
			{ x: 10, y: 0 },
		];
		const original = pts.map((p) => ({ ...p }));
		trimPolylineEnd(pts, 3);
		expect(pts).toEqual(original);
	});
});

describe("buildRenderGraph", () => {
	const makeLayout = (
		blocks: Array<{
			id: string;
			label: string;
			width: number;
			height: number;
			x: number;
			y: number;
			edges: Array<{
				color: "red" | "green" | "blue" | "grey";
				dest: number;
				path: Array<{
					start: { x: number; y: number };
					end: { x: number; y: number };
				}>;
			}>;
		}>,
	) =>
		({
			blocks: blocks.map((b) => ({
				data: {
					id: b.id,
					label: b.label,
					width: b.width,
					height: b.height,
				},
				coordinates: { x: b.x, y: b.y },
				edges: b.edges.map((e) => ({
					color: e.color,
					dest: e.dest,
					mainColumn: 0,
					path: e.path.map((seg) => ({
						start: { x: seg.start.x, y: seg.start.y, row: 0, col: 0 },
						end: { x: seg.end.x, y: seg.end.y, row: 0, col: 0 },
						horizontalOffset: 0,
						verticalOffset: 0,
						type: 0,
						less_than: () => false,
					})),
				})),
				dagEdges: [],
				treeEdges: [],
				treeParent: null,
				row: 0,
				col: 0,
				pendingRowShift: 0,
				pendingColShift: 0,
				boundingBox: { width: 0, height: 0, rows: [] },
				incidentEdgeCount: 0,
			})),
		}) as unknown as GraphLayoutCore;

	const stubResult: CfgBuildResult = {
		anchorAddress: 0n,
		blocks: [],
		edges: [],
		stats: {
			blockCount: 0,
			edgeCount: 0,
			instructionCount: 0,
			truncated: false,
		},
	};

	test("creates nodes with correct attributes", () => {
		const layout = makeLayout([
			{
				id: "block:a",
				label: "label-a",
				width: 120,
				height: 80,
				x: 10,
				y: 20,
				edges: [],
			},
		]);

		const result = buildRenderGraph(stubResult, layout);
		expect(result.nodes.length).toBe(1);
		expect(result.nodeMap.has("block:a")).toBe(true);

		const node = result.nodes[0];
		expect(node.x).toBe(10);
		expect(node.y).toBe(-20);
		expect(node.width).toBe(120);
		expect(node.height).toBe(80);
		expect(node.borderColor).toBe("#d1d5db");
	});

	test("creates edges with correct attributes", () => {
		const layout = makeLayout([
			{
				id: "block:a",
				label: "a",
				width: 100,
				height: 50,
				x: 0,
				y: 0,
				edges: [
					{
						color: "green",
						dest: 1,
						path: [
							{ start: { x: 50, y: 50 }, end: { x: 50, y: 100 } },
							{ start: { x: 50, y: 100 }, end: { x: 50, y: 150 } },
						],
					},
				],
			},
			{
				id: "block:b",
				label: "b",
				width: 100,
				height: 50,
				x: 0,
				y: 200,
				edges: [],
			},
		]);

		const result = buildRenderGraph(stubResult, layout);
		expect(result.edges.length).toBe(1);

		const edge = result.edges[0];
		expect(edge.key).toBe("block:a\u2192block:b");
		expect(edge.color).toBe("#009b5e");
		expect(edge.polylinePoints).toEqual([
			{ x: 50, y: -50 },
			{ x: 50, y: -100 },
			{ x: 50, y: -150 },
		]);
	});

	test("deduplicates consecutive identical points in polyline", () => {
		const layout = makeLayout([
			{
				id: "block:a",
				label: "a",
				width: 100,
				height: 50,
				x: 0,
				y: 0,
				edges: [
					{
						color: "red",
						dest: 1,
						path: [
							{ start: { x: 10, y: 20 }, end: { x: 10, y: 20 } },
							{ start: { x: 10, y: 20 }, end: { x: 30, y: 40 } },
						],
					},
				],
			},
			{
				id: "block:b",
				label: "b",
				width: 100,
				height: 50,
				x: 0,
				y: 100,
				edges: [],
			},
		]);

		const result = buildRenderGraph(stubResult, layout);
		expect(result.edges[0].polylinePoints).toEqual([
			{ x: 10, y: -20 },
			{ x: 30, y: -40 },
		]);
	});

	test("maps all edge colors correctly", () => {
		const colors = ["red", "green", "blue", "grey"] as const;
		const expected = ["#f30c00", "#009b5e", "#3575fe", "#B45309"];

		for (let i = 0; i < colors.length; i++) {
			const layout = makeLayout([
				{
					id: `block:${i}a`,
					label: "a",
					width: 10,
					height: 10,
					x: 0,
					y: 0,
					edges: [
						{
							color: colors[i],
							dest: 1,
							path: [{ start: { x: 0, y: 0 }, end: { x: 1, y: 1 } }],
						},
					],
				},
				{
					id: `block:${i}b`,
					label: "b",
					width: 10,
					height: 10,
					x: 0,
					y: 100,
					edges: [],
				},
			]);

			const result = buildRenderGraph(stubResult, layout);
			const edgeKey = `block:${i}a\u2192block:${i}b`;
			const edge = result.edges.find((e) => e.key === edgeKey);
			expect(edge).toBeDefined();
			expect(edge?.color).toBe(expected[i]);
		}
	});

	test("skips edges with unknown dest index", () => {
		const layout = makeLayout([
			{
				id: "block:a",
				label: "a",
				width: 100,
				height: 50,
				x: 0,
				y: 0,
				edges: [
					{
						color: "blue",
						dest: 99,
						path: [{ start: { x: 0, y: 0 }, end: { x: 1, y: 1 } }],
					},
				],
			},
		]);

		const result = buildRenderGraph(stubResult, layout);
		expect(result.edges.length).toBe(0);
	});

	test("handles empty layout", () => {
		const layout = makeLayout([]);
		const result = buildRenderGraph(stubResult, layout);
		expect(result.nodes.length).toBe(0);
		expect(result.edges.length).toBe(0);
	});
});
