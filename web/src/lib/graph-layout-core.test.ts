import { describe, expect, it } from "bun:test";
import { GraphLayoutCore } from "./graph-layout-core";

type TestBlock = GraphLayoutCore["blocks"][number];

const makeBlock = (treeEdges: number[] = []): TestBlock => ({
	data: {
		id: "",
		width: 0,
		height: 0,
	},
	edges: [],
	dagEdges: [],
	treeEdges,
	treeParent: null,
	row: 0,
	col: 0,
	pendingRowShift: 0,
	pendingColShift: 0,
	boundingBox: {
		width: 2,
		height: 1,
		rows: [{ start: 0, end: 2 }],
	},
	coordinates: { x: 0, y: 0 },
	incidentEdgeCount: 0,
});

const makeLayout = (blocks: TestBlock[]) => {
	const layout = Object.create(GraphLayoutCore.prototype) as GraphLayoutCore;
	layout.blocks = blocks;
	return layout;
};

describe("GraphLayoutCore.propagateShifts", () => {
	it("propagates parent and child pending shifts cumulatively", () => {
		const blocks = [makeBlock([1]), makeBlock([2]), makeBlock()];
		blocks[0].pendingRowShift = 2;
		blocks[0].pendingColShift = 3;
		blocks[1].row = 5;
		blocks[1].col = 7;
		blocks[1].pendingRowShift = 11;
		blocks[1].pendingColShift = 13;
		blocks[1].boundingBox.rows = [{ start: 10, end: 12 }];
		blocks[2].row = 17;
		blocks[2].col = 19;
		blocks[2].boundingBox.rows = [{ start: 20, end: 22 }];

		const layout = makeLayout(blocks);
		layout.propagateShifts(0);

		expect(blocks[0].pendingRowShift).toBe(0);
		expect(blocks[0].pendingColShift).toBe(0);
		expect(blocks[1].row).toBe(7);
		expect(blocks[1].col).toBe(10);
		expect(blocks[1].boundingBox.rows).toEqual([{ start: 13, end: 15 }]);
		expect(blocks[1].pendingRowShift).toBe(0);
		expect(blocks[1].pendingColShift).toBe(0);
		expect(blocks[2].row).toBe(30);
		expect(blocks[2].col).toBe(35);
		expect(blocks[2].boundingBox.rows).toEqual([{ start: 36, end: 38 }]);
		expect(blocks[2].pendingRowShift).toBe(0);
		expect(blocks[2].pendingColShift).toBe(0);
	});

	it("handles very deep trees without recursive stack growth", () => {
		const depth = 50000;
		const blocks = Array.from({ length: depth }, (_, index) => {
			const block = makeBlock(index + 1 < depth ? [index + 1] : []);
			block.row = index;
			block.boundingBox.rows = [{ start: index, end: index + 2 }];
			return block;
		});
		blocks[0].pendingRowShift = 1;
		blocks[0].pendingColShift = 2;

		const layout = makeLayout(blocks);

		expect(() => layout.propagateShifts(0)).not.toThrow();
		expect(blocks[1].row).toBe(2);
		expect(blocks[1].col).toBe(2);
		expect(blocks[Math.floor(depth / 2)].row).toBe(Math.floor(depth / 2) + 1);
		expect(blocks[Math.floor(depth / 2)].col).toBe(2);
		expect(blocks[depth - 1].row).toBe(depth);
		expect(blocks[depth - 1].col).toBe(2);
		expect(blocks[depth - 1].boundingBox.rows).toEqual([
			{ start: depth + 1, end: depth + 3 },
		]);
		expect(blocks[depth - 1].pendingRowShift).toBe(0);
		expect(blocks[depth - 1].pendingColShift).toBe(0);
	});
});
