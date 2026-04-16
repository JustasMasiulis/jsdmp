import { describe, it } from "bun:test";
import { DeterministicRng } from "./deterministic-rng";
import {
	type AnnotatedCfgDescriptor,
	GraphLayoutCore,
} from "./graph-layout-core";

type Point = { x: number; y: number };

type LayoutInput = {
	nodeCount: number;
	edges: Array<{ src: number; dst: number }>;
	nodeWidths: Float64Array;
	nodeHeights: Float64Array;
};

type LayoutResult = {
	xs: Float64Array;
	ys: Float64Array;
	nodeWidths: Float64Array;
	nodeHeights: Float64Array;
	edgePolylines: Array<Array<Point>>;
};

function runLayout(input: LayoutInput): LayoutResult {
	const cfg: AnnotatedCfgDescriptor = {
		nodes: [],
		edges: [],
	};
	for (let i = 0; i < input.nodeCount; i++) {
		cfg.nodes.push({
			id: String(i),
			width: input.nodeWidths[i],
			height: input.nodeHeights[i],
		});
	}
	for (const { src, dst } of input.edges) {
		cfg.edges.push({
			from: String(src),
			to: String(dst),
			arrows: "",
			color: "blue",
		});
	}

	const core = new GraphLayoutCore(cfg, false, false);

	const xs = new Float64Array(input.nodeCount);
	const ys = new Float64Array(input.nodeCount);
	const nodeWidths = new Float64Array(input.nodeCount);
	const nodeHeights = new Float64Array(input.nodeCount);
	for (let i = 0; i < input.nodeCount; i++) {
		xs[i] = core.blocks[i].coordinates.x;
		ys[i] = core.blocks[i].coordinates.y;
		nodeWidths[i] = core.blocks[i].data.width;
		nodeHeights[i] = core.blocks[i].data.height;
	}

	// populate_graph pushes core edges into blocks[from].edges in the same
	// order that cfg.edges appears for that source. Walk the input edge list
	// per-source with a running cursor to match each input edge to its core
	// edge path.
	const cursors = new Int32Array(input.nodeCount);
	const edgePolylines: Array<Array<Point>> = new Array(input.edges.length);
	for (let e = 0; e < input.edges.length; e++) {
		const { src, dst } = input.edges[e];
		const block = core.blocks[src];
		const idx = cursors[src]++;
		const coreEdge = block.edges[idx];
		if (!coreEdge || coreEdge.dest !== dst) {
			edgePolylines[e] = [];
			continue;
		}
		const pts: Array<Point> = [];
		if (coreEdge.path.length > 0) {
			pts.push({ x: coreEdge.path[0].start.x, y: coreEdge.path[0].start.y });
			for (const seg of coreEdge.path) {
				pts.push({ x: seg.end.x, y: seg.end.y });
			}
		}
		const dedup: Array<Point> = [];
		for (const p of pts) {
			const last = dedup[dedup.length - 1];
			if (!last || last.x !== p.x || last.y !== p.y) dedup.push(p);
		}
		edgePolylines[e] = dedup;
	}

	return { xs, ys, nodeWidths, nodeHeights, edgePolylines };
}

function makeSeededRng(seed: number): DeterministicRng {
	const rng = new DeterministicRng();
	for (let i = 0; i < (seed & 0xffff) + 17; i++) rng.next();
	return rng;
}

function randInt(rng: DeterministicRng, lo: number, hi: number): number {
	return lo + Math.floor(rng.next() * (hi - lo + 1));
}

function makeInput(
	nodeCount: number,
	edges: Array<{ src: number; dst: number }>,
	widths?: number[],
	heights?: number[],
): LayoutInput {
	return {
		nodeCount,
		edges,
		nodeWidths: new Float64Array(widths ?? new Array(nodeCount).fill(100)),
		nodeHeights: new Float64Array(heights ?? new Array(nodeCount).fill(40)),
	};
}

// --- Graph generators ---------------------------------------------------

function generateRandomDAG(
	rng: DeterministicRng,
	nodeCount: number,
	edgeCount: number,
): Array<{ src: number; dst: number }> {
	const edges: Array<{ src: number; dst: number }> = [];
	const seen = new Set<string>();
	// Ensure every node (except 0) has at least one parent from a lower id
	for (let n = 1; n < nodeCount; n++) {
		const src = randInt(rng, 0, n - 1);
		edges.push({ src, dst: n });
		seen.add(`${src},${n}`);
	}
	while (edges.length < edgeCount) {
		const a = randInt(rng, 0, nodeCount - 2);
		const b = randInt(rng, a + 1, nodeCount - 1);
		const key = `${a},${b}`;
		if (seen.has(key)) continue;
		seen.add(key);
		edges.push({ src: a, dst: b });
	}
	return edges;
}

function generateConvergent(
	chainCount: number,
	chainLen: number,
): { nodeCount: number; edges: Array<{ src: number; dst: number }> } {
	const nodeCount = 1 + chainCount * chainLen + 1;
	const root = 0;
	const sink = nodeCount - 1;
	const edges: Array<{ src: number; dst: number }> = [];
	for (let i = 0; i < chainCount; i++) {
		const base = 1 + i * chainLen;
		edges.push({ src: root, dst: base });
		for (let j = 0; j < chainLen - 1; j++) {
			edges.push({ src: base + j, dst: base + j + 1 });
		}
		edges.push({ src: base + chainLen - 1, dst: sink });
	}
	return { nodeCount, edges };
}

function generateDivergent(
	chainCount: number,
	chainLen: number,
): { nodeCount: number; edges: Array<{ src: number; dst: number }> } {
	const nodeCount = 1 + chainCount * chainLen + 1;
	const root = 0;
	const sink = nodeCount - 1;
	const edges: Array<{ src: number; dst: number }> = [];
	for (let i = 0; i < chainCount; i++) {
		const base = 1 + i * chainLen;
		edges.push({ src: root, dst: base });
		for (let j = 0; j < chainLen - 1; j++) {
			edges.push({ src: base + j, dst: base + j + 1 });
		}
		edges.push({ src: base + chainLen - 1, dst: sink });
	}
	return { nodeCount, edges };
}

function generateCFGLike(
	rng: DeterministicRng,
	spineLen: number,
	branchCount: number,
	branchLen: number,
	exitCount: number,
): { nodeCount: number; edges: Array<{ src: number; dst: number }> } {
	const nodeCount = spineLen + branchCount * branchLen + exitCount;
	const edges: Array<{ src: number; dst: number }> = [];
	for (let i = 0; i < spineLen - 1; i++) edges.push({ src: i, dst: i + 1 });
	const exits: number[] = [];
	for (let i = 0; i < exitCount; i++) exits.push(nodeCount - exitCount + i);

	for (let b = 0; b < branchCount; b++) {
		const base = spineLen + b * branchLen;
		const attach = randInt(rng, 0, spineLen - 2);
		edges.push({ src: attach, dst: base });
		for (let j = 0; j < branchLen - 1; j++) {
			edges.push({ src: base + j, dst: base + j + 1 });
		}
		const exit = exits[b % exitCount];
		edges.push({ src: base + branchLen - 1, dst: exit });
	}
	// Direct long jumps from spine to exits
	const jumpCount = Math.min(spineLen / 3, 30);
	for (let i = 0; i < jumpCount; i++) {
		const src = randInt(rng, 0, spineLen - 2);
		const dst = exits[randInt(rng, 0, exitCount - 1)];
		edges.push({ src, dst });
	}
	// Spine end to first exit
	edges.push({ src: spineLen - 1, dst: exits[0] });
	return { nodeCount, edges };
}

// --- Assertions ---------------------------------------------------------

function segmentIntersectsRect(
	ax: number,
	ay: number,
	bx: number,
	by: number,
	rx: number,
	ry: number,
	rw: number,
	rh: number,
): boolean {
	// Liang-Barsky clipping: returns true if [a,b] enters the rectangle.
	let t0 = 0;
	let t1 = 1;
	const dx = bx - ax;
	const dy = by - ay;
	const clip = (p: number, q: number): boolean => {
		if (p === 0) return q >= 0;
		const r = q / p;
		if (p < 0) {
			if (r > t1) return false;
			if (r > t0) t0 = r;
		} else {
			if (r < t0) return false;
			if (r < t1) t1 = r;
		}
		return true;
	};
	if (
		!clip(-dx, ax - rx) ||
		!clip(dx, rx + rw - ax) ||
		!clip(-dy, ay - ry) ||
		!clip(dy, ry + rh - ay)
	)
		return false;
	return t0 < t1;
}

function findEdgeNodeOverlap(
	input: LayoutInput,
	result: LayoutResult,
): { edge: number; node: number; seg: number } | null {
	// Inset the node rectangle slightly so a polyline that legitimately touches
	// the top edge of its endpoint isn't flagged. Edge endpoints are excluded
	// anyway, but neighbor nodes at the same X column should not be crossed.
	const INSET = 0.5;
	for (let e = 0; e < input.edges.length; e++) {
		const polyline = result.edgePolylines[e];
		if (!polyline || polyline.length < 2) continue;
		const { src, dst } = input.edges[e];
		for (let i = 0; i < polyline.length - 1; i++) {
			const a = polyline[i];
			const b = polyline[i + 1];
			for (let n = 0; n < input.nodeCount; n++) {
				if (n === src || n === dst) continue;
				if (
					segmentIntersectsRect(
						a.x,
						a.y,
						b.x,
						b.y,
						result.xs[n] + INSET,
						result.ys[n] + INSET,
						result.nodeWidths[n] - 2 * INSET,
						result.nodeHeights[n] - 2 * INSET,
					)
				) {
					return { edge: e, node: n, seg: i };
				}
			}
		}
	}
	return null;
}

function findBadBend(
	input: LayoutInput,
	result: LayoutResult,
): { edge: number; reason: string } | null {
	for (let e = 0; e < result.edgePolylines.length; e++) {
		const poly = result.edgePolylines[e];
		if (poly.length < 2) continue;

		// All points must be finite.
		for (const p of poly) {
			if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) {
				return { edge: e, reason: "non-finite point" };
			}
		}

		// No two consecutive points may be identical (wastes a bend slot).
		for (let i = 0; i < poly.length - 1; i++) {
			if (poly[i].x === poly[i + 1].x && poly[i].y === poly[i + 1].y) {
				return { edge: e, reason: `duplicate point at index ${i}` };
			}
		}

		// No zig-zag: three consecutive collinear-axis segments shouldn't be
		// left in the polyline (they should have been simplified).
		for (let i = 0; i < poly.length - 2; i++) {
			const dx1 = poly[i + 1].x - poly[i].x;
			const dy1 = poly[i + 1].y - poly[i].y;
			const dx2 = poly[i + 2].x - poly[i + 1].x;
			const dy2 = poly[i + 2].y - poly[i + 1].y;
			if (Math.abs(dx1 * dy2 - dy1 * dx2) < 1e-6) {
				return {
					edge: e,
					reason: `collinear or degenerate triple at index ${i}`,
				};
			}
		}

		// The horizontal bend leading into the target must sit strictly above
		// the target's top edge, not on it. A bend at Y == target_top means
		// the edge hugs the top border of the target node instead of routing
		// through the gutter above.
		const edge = input.edges[e];
		const srcTop = result.ys[edge.src];
		const dstTop = result.ys[edge.dst];
		const last = poly[poly.length - 1];
		const isDownward = dstTop > srcTop;
		if (isDownward && poly.length >= 3) {
			// Walk backwards to find the first point that is NOT on the final
			// vertical segment leading into target_top.
			for (let i = poly.length - 2; i >= 0; i--) {
				const p = poly[i];
				if (p.x !== last.x || p.y !== last.y) {
					if (p.y >= dstTop - 0.5) {
						return {
							edge: e,
							reason: `bend at y=${p.y.toFixed(1)} is at/below target top y=${dstTop.toFixed(1)}`,
						};
					}
					break;
				}
			}
		}
	}
	return null;
}

const VERTICAL_OVERLAP_TOLERANCE = 0.5;

function findCollinearEdgeOverlap(
	result: LayoutResult,
	edges: ReadonlyArray<{ src: number; dst: number }>,
): {
	edge1: number;
	edge2: number;
	seg1: number;
	seg2: number;
	axis: "h" | "v";
} | null {
	const EPS = 0.5;

	type Seg = {
		lo: number;
		hi: number;
		coord: number;
		edge: number;
		seg: number;
	};
	const hSegs: Seg[] = [];
	const vSegs: Seg[] = [];

	for (let e = 0; e < result.edgePolylines.length; e++) {
		const poly = result.edgePolylines[e];
		if (!poly || poly.length < 2) continue;
		for (let i = 0; i < poly.length - 1; i++) {
			const a = poly[i];
			const b = poly[i + 1];
			if (Math.abs(a.y - b.y) < EPS) {
				hSegs.push({
					lo: Math.min(a.x, b.x),
					hi: Math.max(a.x, b.x),
					coord: a.y,
					edge: e,
					seg: i,
				});
			} else if (Math.abs(a.x - b.x) < EPS) {
				vSegs.push({
					lo: Math.min(a.y, b.y),
					hi: Math.max(a.y, b.y),
					coord: a.x,
					edge: e,
					seg: i,
				});
			}
		}
	}

	const check = (
		segs: Seg[],
		axis: "h" | "v",
		minOverlap: number,
	): {
		edge1: number;
		edge2: number;
		seg1: number;
		seg2: number;
		axis: "h" | "v";
	} | null => {
		segs.sort((a, b) => a.coord - b.coord || a.lo - b.lo);
		for (let i = 0; i < segs.length; i++) {
			for (let j = i + 1; j < segs.length; j++) {
				if (Math.abs(segs[j].coord - segs[i].coord) >= EPS) break;
				const a = segs[i];
				const b = segs[j];
				if (a.edge === b.edge) continue;
				const { src: s1, dst: d1 } = edges[a.edge];
				const { src: s2, dst: d2 } = edges[b.edge];
				if (s1 === s2 || s1 === d2 || d1 === s2 || d1 === d2) continue;
				const overlapLen = Math.min(a.hi, b.hi) - Math.max(a.lo, b.lo);
				if (overlapLen > minOverlap) {
					return {
						edge1: a.edge,
						edge2: b.edge,
						seg1: a.seg,
						seg2: b.seg,
						axis,
					};
				}
			}
		}
		return null;
	};

	return (
		check(hSegs, "h", EPS) ?? check(vSegs, "v", VERTICAL_OVERLAP_TOLERANCE)
	);
}

function findExcessiveBends(
	result: LayoutResult,
	maxDistinctX: number,
): { edge: number; distinctX: number } | null {
	for (let e = 0; e < result.edgePolylines.length; e++) {
		const poly = result.edgePolylines[e];
		const xs = new Set<number>();
		for (const p of poly) xs.add(Math.round(p.x));
		if (xs.size > maxDistinctX) {
			return { edge: e, distinctX: xs.size };
		}
	}
	return null;
}

function assertClean(
	input: LayoutInput,
	result: LayoutResult,
	label: string,
	options: { maxDistinctX?: number } = {},
): void {
	const badBend = findBadBend(input, result);
	if (badBend) {
		throw new Error(
			`${label}: bad polyline on edge ${badBend.edge}: ${badBend.reason}`,
		);
	}

	const overlap = findEdgeNodeOverlap(input, result);
	if (overlap) {
		const poly = result.edgePolylines[overlap.edge];
		const edge = input.edges[overlap.edge];
		const nx = result.xs[overlap.node];
		const ny = result.ys[overlap.node];
		const nw = result.nodeWidths[overlap.node];
		const nh = result.nodeHeights[overlap.node];
		throw new Error(
			`${label}: edge ${overlap.edge} (${edge.src}→${edge.dst}) segment ${overlap.seg} crosses node ${overlap.node} [${nx},${ny},${nw}x${nh}]; polyline=${poly.map((p) => `(${p.x.toFixed(0)},${p.y.toFixed(0)})`).join(" ")}`,
		);
	}

	if (options.maxDistinctX !== undefined) {
		const excess = findExcessiveBends(result, options.maxDistinctX);
		if (excess) {
			const poly = result.edgePolylines[excess.edge];
			throw new Error(
				`${label}: edge ${excess.edge} has ${excess.distinctX} distinct X values (max ${options.maxDistinctX}); polyline=${poly.map((p) => `(${p.x.toFixed(0)},${p.y.toFixed(0)})`).join(" ")}`,
			);
		}
	}
}

// --- Tests --------------------------------------------------------------

describe("graph-layout-core fuzz", () => {
	it("convergent graphs stay straight and non-overlapping", () => {
		for (const [chainCount, chainLen] of [
			[3, 5],
			[5, 8],
			[10, 12],
			[20, 6],
			[15, 10],
		] as const) {
			const spec = generateConvergent(chainCount, chainLen);
			const input = makeInput(spec.nodeCount, spec.edges);
			const result = runLayout(input);
			// A pure convergent graph (no obstacles in chain columns) should
			// produce perfectly straight chains — at most 2 distinct X values
			// per edge (source port X and sink port X).
			assertClean(input, result, `convergent ${chainCount}x${chainLen}`, {
				maxDistinctX: 2,
			});
		}
	});

	it("divergent graphs stay straight and non-overlapping", () => {
		for (const [chainCount, chainLen] of [
			[3, 5],
			[5, 8],
			[10, 10],
		] as const) {
			const spec = generateDivergent(chainCount, chainLen);
			const input = makeInput(spec.nodeCount, spec.edges);
			const result = runLayout(input);
			assertClean(input, result, `divergent ${chainCount}x${chainLen}`, {
				maxDistinctX: 2,
			});
		}
	});

	it("CFG-like graphs have no edge-node overlaps", () => {
		for (let seed = 0; seed < 20; seed++) {
			const rng = makeSeededRng(seed);
			const spineLen = randInt(rng, 10, 40);
			const branchCount = randInt(rng, 3, 15);
			const branchLen = randInt(rng, 2, 6);
			const exitCount = randInt(rng, 1, 4);
			const spec = generateCFGLike(
				rng,
				spineLen,
				branchCount,
				branchLen,
				exitCount,
			);
			const input = makeInput(spec.nodeCount, spec.edges);
			const result = runLayout(input);
			assertClean(
				input,
				result,
				`cfg-like seed=${seed} spine=${spineLen} branches=${branchCount}x${branchLen} exits=${exitCount}`,
			);
		}
	});

	it("random DAGs have no edge-node overlaps", () => {
		for (let seed = 0; seed < 25; seed++) {
			const rng = makeSeededRng(seed * 31 + 7);
			const nodeCount = randInt(rng, 4, 30);
			const maxEdges = (nodeCount * (nodeCount - 1)) / 2;
			const edgeCount = Math.min(
				maxEdges,
				nodeCount + randInt(rng, 0, nodeCount),
			);
			const edges = generateRandomDAG(rng, nodeCount, edgeCount);
			const input = makeInput(nodeCount, edges);
			const result = runLayout(input);
			assertClean(
				input,
				result,
				`random-dag seed=${seed} nodes=${nodeCount} edges=${edgeCount}`,
			);
		}
	});

	it("varied node sizes have no edge-node overlaps", () => {
		for (let seed = 0; seed < 15; seed++) {
			const rng = makeSeededRng(seed * 13 + 3);
			const nodeCount = randInt(rng, 6, 25);
			const maxEdges = (nodeCount * (nodeCount - 1)) / 2;
			const edgeCount = Math.min(maxEdges, nodeCount + randInt(rng, 0, 10));
			const edges = generateRandomDAG(rng, nodeCount, edgeCount);
			const widths: number[] = [];
			const heights: number[] = [];
			for (let i = 0; i < nodeCount; i++) {
				widths.push(randInt(rng, 40, 200));
				heights.push(randInt(rng, 20, 80));
			}
			const input = makeInput(nodeCount, edges, widths, heights);
			const result = runLayout(input);
			assertClean(
				input,
				result,
				`varied-sizes seed=${seed} nodes=${nodeCount}`,
			);
		}
	});

	it("deep chains with side nodes stay obstacle-free", () => {
		// A long chain with occasional side branches. Long edges through the
		// chain should route around the side nodes without crossing them.
		for (let seed = 0; seed < 15; seed++) {
			const rng = makeSeededRng(seed * 97 + 11);
			const spineLen = randInt(rng, 15, 35);
			const edges: Array<{ src: number; dst: number }> = [];
			for (let i = 0; i < spineLen - 1; i++) edges.push({ src: i, dst: i + 1 });
			const sideNodes: number[] = [];
			const sideCount = randInt(rng, 3, 8);
			let nextNode = spineLen;
			for (let s = 0; s < sideCount; s++) {
				const attach = randInt(rng, 1, spineLen - 2);
				sideNodes.push(nextNode);
				edges.push({ src: attach, dst: nextNode });
				edges.push({ src: nextNode, dst: attach + 1 });
				nextNode++;
			}
			// Some long edges: spine[a] -> spine[b] with b - a > 3
			const longEdgeCount = randInt(rng, 2, 5);
			for (let l = 0; l < longEdgeCount; l++) {
				const a = randInt(rng, 0, spineLen - 6);
				const b = randInt(rng, a + 4, spineLen - 1);
				edges.push({ src: a, dst: b });
			}
			const input = makeInput(nextNode, edges);
			const result = runLayout(input);
			assertClean(input, result, `deep-chain seed=${seed} spine=${spineLen}`);
		}
	});

	it("no collinear edge overlaps on random DAGs", () => {
		for (let seed = 0; seed < 25; seed++) {
			const rng = makeSeededRng(seed * 31 + 7);
			const nodeCount = randInt(rng, 4, 30);
			const maxEdges = (nodeCount * (nodeCount - 1)) / 2;
			const edgeCount = Math.min(
				maxEdges,
				nodeCount + randInt(rng, 0, nodeCount),
			);
			const edges = generateRandomDAG(rng, nodeCount, edgeCount);
			const input = makeInput(nodeCount, edges);
			const result = runLayout(input);
			const overlap = findCollinearEdgeOverlap(result, edges);
			if (overlap) {
				const p1 = result.edgePolylines[overlap.edge1];
				const p2 = result.edgePolylines[overlap.edge2];
				const e1 = edges[overlap.edge1];
				const e2 = edges[overlap.edge2];
				throw new Error(
					`seed=${seed}: edges ${overlap.edge1} (${e1.src}→${e1.dst}) seg ${overlap.seg1} and ${overlap.edge2} (${e2.src}→${e2.dst}) seg ${overlap.seg2} overlap on ${overlap.axis} axis; ` +
						`poly1=${p1.map((p) => `(${p.x.toFixed(0)},${p.y.toFixed(0)})`).join(" ")} ` +
						`poly2=${p2.map((p) => `(${p.x.toFixed(0)},${p.y.toFixed(0)})`).join(" ")}`,
				);
			}
		}
	});

	it("no collinear edge overlaps on CFG-like graphs", () => {
		for (let seed = 0; seed < 20; seed++) {
			const rng = makeSeededRng(seed);
			const spineLen = randInt(rng, 10, 40);
			const branchCount = randInt(rng, 3, 15);
			const branchLen = randInt(rng, 2, 6);
			const exitCount = randInt(rng, 1, 4);
			const spec = generateCFGLike(
				rng,
				spineLen,
				branchCount,
				branchLen,
				exitCount,
			);
			const input = makeInput(spec.nodeCount, spec.edges);
			const result = runLayout(input);
			const overlap = findCollinearEdgeOverlap(result, spec.edges);
			if (overlap) {
				const e1 = spec.edges[overlap.edge1];
				const e2 = spec.edges[overlap.edge2];
				throw new Error(
					`cfg-like seed=${seed}: edges ${overlap.edge1} (${e1.src}→${e1.dst}) and ${overlap.edge2} (${e2.src}→${e2.dst}) overlap on ${overlap.axis} axis`,
				);
			}
		}
	});
});

function layoutWidth(input: LayoutInput): number {
	const cfg: AnnotatedCfgDescriptor = { nodes: [], edges: [] };
	for (let i = 0; i < input.nodeCount; i++) {
		cfg.nodes.push({
			id: String(i),
			width: input.nodeWidths[i],
			height: input.nodeHeights[i],
		});
	}
	for (const { src, dst } of input.edges) {
		cfg.edges.push({
			from: String(src),
			to: String(dst),
			arrows: "",
			color: "blue",
		});
	}
	return new GraphLayoutCore(cfg, false, false).getWidth();
}

describe("graph-layout-core width metrics (informational)", () => {
	// These tests never fail; they record layout width across representative
	// scenarios so alternative algorithms can print their totals and be
	// compared against this baseline. The bun test runner prints console.log
	// output, so grep the test output for "WIDTH_TOTAL:" to score a variant.
	it("cfg-like width sum over 20 seeds", () => {
		let total = 0;
		const widths: number[] = [];
		for (let seed = 0; seed < 20; seed++) {
			const rng = makeSeededRng(seed);
			const spineLen = randInt(rng, 10, 40);
			const branchCount = randInt(rng, 3, 15);
			const branchLen = randInt(rng, 2, 6);
			const exitCount = randInt(rng, 1, 4);
			const spec = generateCFGLike(
				rng,
				spineLen,
				branchCount,
				branchLen,
				exitCount,
			);
			const w = layoutWidth(makeInput(spec.nodeCount, spec.edges));
			total += w;
			widths.push(Math.round(w));
		}
		console.log(`WIDTH_CFG_LIKE_TOTAL: ${Math.round(total)} px`);
		console.log(`WIDTH_CFG_LIKE_PER_SEED: [${widths.join(", ")}]`);
	});

	it("random-dag width sum over 25 seeds", () => {
		let total = 0;
		for (let seed = 0; seed < 25; seed++) {
			const rng = makeSeededRng(seed * 31 + 7);
			const nodeCount = randInt(rng, 4, 30);
			const maxEdges = (nodeCount * (nodeCount - 1)) / 2;
			const edgeCount = Math.min(
				maxEdges,
				nodeCount + randInt(rng, 0, nodeCount),
			);
			const edges = generateRandomDAG(rng, nodeCount, edgeCount);
			total += layoutWidth(makeInput(nodeCount, edges));
		}
		console.log(`WIDTH_RANDOM_DAG_TOTAL: ${Math.round(total)} px`);
	});

	it("deep-chain width sum over 15 seeds", () => {
		let total = 0;
		for (let seed = 0; seed < 15; seed++) {
			const rng = makeSeededRng(seed * 97 + 11);
			const spineLen = randInt(rng, 15, 35);
			const edges: Array<{ src: number; dst: number }> = [];
			for (let i = 0; i < spineLen - 1; i++) edges.push({ src: i, dst: i + 1 });
			const sideCount = randInt(rng, 3, 8);
			let nextNode = spineLen;
			for (let s = 0; s < sideCount; s++) {
				const attach = randInt(rng, 1, spineLen - 2);
				edges.push({ src: attach, dst: nextNode });
				edges.push({ src: nextNode, dst: attach + 1 });
				nextNode++;
			}
			const longEdgeCount = randInt(rng, 2, 5);
			for (let l = 0; l < longEdgeCount; l++) {
				const a = randInt(rng, 0, spineLen - 6);
				const b = randInt(rng, a + 4, spineLen - 1);
				edges.push({ src: a, dst: b });
			}
			total += layoutWidth(makeInput(nextNode, edges));
		}
		console.log(`WIDTH_DEEP_CHAIN_TOTAL: ${Math.round(total)} px`);
	});
});
