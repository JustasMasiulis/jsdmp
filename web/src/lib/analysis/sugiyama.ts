import { DeterministicRng } from "./deterministic-rng";
import { classifyEdges, computeEdgeOffsets, dfs, EdgeType } from "./dfs";
import {
	buildDominatorTree,
	computeDominators,
	dominatorDepth,
} from "./dominators";
import { type ReadonlyGraph, UNDEFINED } from "./graph";
import { networkSimplex } from "./network-simplex";

export type IOPair = { node: number; edge: number };

export type CfgAnalysis = {
	backEdges: Uint8Array;
	idom: Uint32Array;
	ipdom: Uint32Array;
	dominatedSetSize: Uint32Array;
	postDomDepth: Uint32Array;
};

export type SugiyamaInput = {
	nodeCount: number;
	edges: ReadonlyArray<{ src: number; dst: number }>;
	nodeWidths: Float64Array;
	nodeHeights: Float64Array;
	root: number;
	entries?: IOPair[];
	exits?: IOPair[];
	startXOffsets?: Float64Array;
	endXOffsets?: Float64Array;
	cfgAnalysis?: CfgAnalysis;
};

export const veilConfig = {
	enabled: false,
	ranking: false,
	backEdgeHint: true,
	dummyTagging: true,
	ordering: true,
	gutter: false,
	straightening: true,
};

const DUMMY_BACK = 2;

export type SugiyamaResult = {
	xs: Float64Array;
	ys: Float64Array;
	edgePolylines: { x: number; y: number }[][];
	ioWaypoints: Map<string, { x: number; y: number }[]>;
	width: number;
	height: number;
	hasTopLoop: boolean;
	hasBottomLoop: boolean;
};

const X_GUTTER = 20;
export const Y_GUTTER = 20;
const EDGE_HEIGHT = 20;
const WAYPOINT_WIDTH = 0;
const WAYPOINT_HEIGHT = 0;
const WAYPOINT_PRIORITY = 1;
const TOLERANCE = 10;

const PAD_TOP = 0;
const PAD_BOTTOM = 1;
const PAD_LEFT = 2;
const PAD_RIGHT = 3;
const PAD_STRIDE = 4;

type Point = { x: number; y: number };

const DFS_UNVISITED = 0;
const DFS_IN_STACK = 1;
const DFS_DONE = 2;

export function sugiyamaLayout(input: SugiyamaInput): SugiyamaResult {
	const { nodeCount, edges, nodeWidths, nodeHeights, root } = input;
	const emptyIoWaypoints = new Map<string, { x: number; y: number }[]>();

	if (nodeCount === 0)
		return {
			xs: new Float64Array(0),
			ys: new Float64Array(0),
			edgePolylines: [],
			ioWaypoints: emptyIoWaypoints,
			width: 0,
			height: 0,
			hasTopLoop: false,
			hasBottomLoop: false,
		};

	const paddings = new Float64Array(nodeCount * PAD_STRIDE);
	for (let i = 0; i < nodeCount; i++) {
		paddings[i * PAD_STRIDE + PAD_LEFT] = X_GUTTER;
		paddings[i * PAD_STRIDE + PAD_RIGHT] = X_GUTTER;
	}

	const succs: number[][] = Array.from({ length: nodeCount }, () => []);
	const preds: number[][] = Array.from({ length: nodeCount }, () => []);
	const selfLoopEdges: number[] = [];
	const edgeIndicesFromNode: number[][] = Array.from(
		{ length: nodeCount },
		() => [],
	);

	for (let e = 0; e < edges.length; e++) {
		const { src, dst } = edges[e];
		succs[src].push(dst);
		preds[dst].push(src);
		edgeIndicesFromNode[src].push(e);
	}

	const isFlipped = new Uint8Array(edges.length);
	const backEdgeHint =
		veilConfig.enabled && veilConfig.backEdgeHint && input.cfgAnalysis
			? input.cfgAnalysis.backEdges
			: undefined;
	cycleRemoval(
		nodeCount,
		root,
		succs,
		preds,
		isFlipped,
		edgeIndicesFromNode,
		selfLoopEdges,
		paddings,
		backEdgeHint,
	);

	const selfLoopSet = new Set(selfLoopEdges);

	const layerArr =
		veilConfig.enabled && veilConfig.ranking && input.cfgAnalysis
			? veilRanking(
					nodeCount,
					root,
					edges,
					isFlipped,
					selfLoopSet,
					input.cfgAnalysis,
				)
			: networkSimplex(nodeCount, succs, preds, root).layers;

	slideNodes(nodeCount, layerArr, succs, preds, nodeHeights, paddings);

	const g = buildExpandedGraph(
		nodeCount,
		edges,
		isFlipped,
		selfLoopSet,
		layerArr,
		nodeWidths,
		nodeHeights,
		paddings,
		input.entries,
		input.exits,
		input.startXOffsets,
		input.endXOffsets,
	);

	const nodeLayers: number[][] = Array.from({ length: g.layerCount }, () => []);
	for (let i = 0; i < g.nodeCount; i++) {
		nodeLayers[g.layer[i]].push(i);
	}

	const preFlipFrom = new Int32Array(g.edges.length);
	const preFlipTo = new Int32Array(g.edges.length);
	for (let i = 0; i < g.edges.length; i++) {
		preFlipFrom[i] = g.edges[i].from;
		preFlipTo[i] = g.edges[i].to;
	}
	flipExpandedEdges(g);

	const ys = yCoordinateAssignment(g, nodeLayers);

	const order = vertexOrdering(g, nodeLayers);

	for (let l = 0; l < g.layerCount; l++) {
		const ord = new Map<number, number>();
		for (let i = 0; i < order[l].length; i++) {
			ord.set(order[l][i], i);
		}
		nodeLayers[l].sort((a, b) => (ord.get(a) ?? 0) - (ord.get(b) ?? 0));
	}

	const position = new Int32Array(g.nodeCount);
	for (let l = 0; l < g.layerCount; l++)
		for (let i = 0; i < order[l].length; i++) position[order[l][i]] = i;

	waypointCreation(g, order, position, ys);

	const xs = xCoordinateAssignment(g, nodeLayers, order);

	straightenLongEdgeChains(
		g,
		nodeLayers,
		xs,
		veilConfig.enabled && veilConfig.straightening ? isFlipped : undefined,
	);

	translateWaypoints(g, xs);

	calculateWaypointsY(g, nodeLayers, ys);

	const width = computeGraphWidth(g, nodeLayers);
	const height = computeExpandedGraphHeight(g, nodeLayers);

	for (let i = 0; i < g.edges.length; i++) {
		g.edges[i].from = preFlipFrom[i];
		g.edges[i].to = preFlipTo[i];
	}
	for (let i = 0; i < g.nodeCount; i++) {
		g.succs[i] = [];
		g.succEdgeIds[i] = [];
		g.preds[i] = [];
		g.predEdgeIds[i] = [];
	}
	for (let i = 0; i < g.edges.length; i++) {
		const e = g.edges[i];
		addExpandedAdjacency(
			g.succs,
			g.succEdgeIds,
			g.preds,
			g.predEdgeIds,
			i,
			e.from,
			e.to,
		);
	}
	g.edgeFromTo.clear();
	for (let i = 0; i < g.edges.length; i++) {
		g.edgeFromTo.set(`${g.edges[i].from},${g.edges[i].to}`, i);
	}

	const ioWaypoints = makeIoWaypoints(g);

	buildLongEdgesWaypoints(g);

	for (const [origEdgeIdx, chainEdgeIds] of g.deletedOriginalEdges) {
		const origFrom = edges[origEdgeIdx].src;
		const origTo = edges[origEdgeIdx].dst;

		if (ys[origFrom] < ys[origTo]) continue;

		const wp = g.deletedEdgeWaypoints.get(chainEdgeIds);
		if (!wp || wp.length < 8) continue;

		wp.splice(3, 1);
		wp.splice(3, 1);
		wp.splice(wp.length - 4, 1);
		wp.splice(wp.length - 4, 1);
	}

	drawSelfLoops(g, selfLoopEdges, edges, xs, ys);

	const polylines = buildFinalPolylines(edges, g, isFlipped, selfLoopSet);

	return {
		xs: xs.slice(0, nodeCount) as Float64Array,
		ys: ys.slice(0, nodeCount) as Float64Array,
		edgePolylines: polylines,
		ioWaypoints,
		width,
		height,
		hasTopLoop: g.hasTopLoop,
		hasBottomLoop: g.hasBottomLoop,
	};
}

// ---------- 1. Cycle removal (DFS-based) ----------

function removeSelfLoop(
	node: number,
	edgeIdx: number,
	succs: number[][],
	preds: number[][],
	edgeIndicesFromNode: number[][],
	selfLoopEdges: number[],
	paddings: Float64Array,
): void {
	paddings[node * PAD_STRIDE + PAD_RIGHT] += X_GUTTER;
	paddings[node * PAD_STRIDE + PAD_TOP] += EDGE_HEIGHT;
	paddings[node * PAD_STRIDE + PAD_BOTTOM] += EDGE_HEIGHT;

	selfLoopEdges.push(edgeIdx);

	const si = succs[node].indexOf(node);
	if (si !== -1) {
		succs[node].splice(si, 1);
		edgeIndicesFromNode[node].splice(si, 1);
	}
	const pi = preds[node].indexOf(node);
	if (pi !== -1) preds[node].splice(pi, 1);
}

function flipEdge(
	node: number,
	next: number,
	idx: number,
	edgeIdx: number,
	succs: number[][],
	preds: number[][],
	isFlipped: Uint8Array,
	edgeIndicesFromNode: number[][],
): void {
	isFlipped[edgeIdx] = 1;

	succs[node].splice(idx, 1);
	edgeIndicesFromNode[node].splice(idx, 1);
	const pi = preds[next].indexOf(node);
	if (pi !== -1) preds[next].splice(pi, 1);

	succs[next].push(node);
	preds[node].push(next);
	edgeIndicesFromNode[next].push(edgeIdx);
}

function cycleRemoval(
	nodeCount: number,
	root: number,
	succs: number[][],
	preds: number[][],
	isFlipped: Uint8Array,
	edgeIndicesFromNode: number[][],
	selfLoopEdges: number[],
	paddings: Float64Array,
	backEdgeHint?: Uint8Array,
): void {
	if (backEdgeHint) {
		for (let node = 0; node < nodeCount; node++) {
			let idx = 0;
			while (idx < succs[node].length) {
				const next = succs[node][idx];
				const edgeIdx = edgeIndicesFromNode[node][idx];
				if (node === next) {
					removeSelfLoop(
						node,
						edgeIdx,
						succs,
						preds,
						edgeIndicesFromNode,
						selfLoopEdges,
						paddings,
					);
					continue;
				}
				if (backEdgeHint[edgeIdx] && !isFlipped[edgeIdx]) {
					flipEdge(
						node,
						next,
						idx,
						edgeIdx,
						succs,
						preds,
						isFlipped,
						edgeIndicesFromNode,
					);
					continue;
				}
				idx++;
			}
		}
		return;
	}

	const state = new Uint8Array(nodeCount);

	const visit = (start: number) => {
		if (state[start] === DFS_DONE) return;
		state[start] = DFS_IN_STACK;

		const stack = [start];
		const childIdx = [0];

		while (stack.length > 0) {
			const top = stack.length - 1;
			const node = stack[top];
			const idx = childIdx[top];
			const nodeSuccs = succs[node];

			if (idx >= nodeSuccs.length) {
				state[node] = DFS_DONE;
				stack.pop();
				childIdx.pop();
				continue;
			}

			childIdx[top] = idx + 1;
			const next = nodeSuccs[idx];

			if (state[next] === DFS_IN_STACK) {
				const edgeIdx = edgeIndicesFromNode[node][idx];

				if (node === next) {
					removeSelfLoop(
						node,
						edgeIdx,
						succs,
						preds,
						edgeIndicesFromNode,
						selfLoopEdges,
						paddings,
					);
					childIdx[top] = idx;
					continue;
				}

				flipEdge(
					node,
					next,
					idx,
					edgeIdx,
					succs,
					preds,
					isFlipped,
					edgeIndicesFromNode,
				);
				childIdx[top] = idx;
			} else if (state[next] === DFS_UNVISITED) {
				state[next] = DFS_IN_STACK;
				stack.push(next);
				childIdx.push(0);
			}
		}
	};

	visit(root);
}

export const __testing = {
	cycleRemoval,
};

// ---------- CFG analysis for VEIL ----------

function computeSubtreeSizes(
	children: Uint32Array[],
	root: number,
	nodeCount: number,
): Uint32Array {
	const sizes = new Uint32Array(nodeCount).fill(1);
	const order: number[] = [];
	const stack = [root];
	while (stack.length > 0) {
		const v = stack.pop()!;
		order.push(v);
		const kids = children[v];
		for (let i = 0; i < kids.length; i++) stack.push(kids[i]);
	}
	for (let i = order.length - 1; i >= 0; i--) {
		const v = order[i];
		const kids = children[v];
		for (let j = 0; j < kids.length; j++) sizes[v] += sizes[kids[j]];
	}
	return sizes;
}

export function computeCfgAnalysis(
	nodeCount: number,
	edges: ReadonlyArray<{ src: number; dst: number }>,
	root: number,
): CfgAnalysis {
	if (nodeCount === 0) {
		return {
			backEdges: new Uint8Array(0),
			idom: new Uint32Array(0),
			ipdom: new Uint32Array(0),
			dominatedSetSize: new Uint32Array(0),
			postDomDepth: new Uint32Array(0),
		};
	}

	const succs: number[][] = Array.from({ length: nodeCount }, () => []);
	const preds: number[][] = Array.from({ length: nodeCount }, () => []);
	for (let e = 0; e < edges.length; e++) {
		succs[edges[e].src].push(edges[e].dst);
		preds[edges[e].dst].push(edges[e].src);
	}
	const graph: ReadonlyGraph = {
		nodeCount,
		successors: (n) => succs[n],
		predecessors: (n) => preds[n],
	};

	const dfsResult = dfs(graph, root);
	const edgeTypes = classifyEdges(graph, dfsResult);
	const edgeOffsets = computeEdgeOffsets(graph);

	const backEdges = new Uint8Array(edges.length);
	const edgeIdx = new Uint32Array(nodeCount);
	for (let u = 0; u < nodeCount; u++) {
		const uSuccs = succs[u];
		for (let si = 0; si < uSuccs.length; si++) {
			if (edgeTypes[edgeOffsets[u] + si] === EdgeType.BACK) {
				const v = uSuccs[si];
				const idx = edgeIdx[u];
				for (let e = idx; e < edges.length; e++) {
					if (edges[e].src === u && edges[e].dst === v) {
						backEdges[e] = 1;
						edgeIdx[u] = e + 1;
						break;
					}
				}
			}
		}
	}

	const fwdSuccs: number[][] = Array.from({ length: nodeCount }, () => []);
	const fwdPreds: number[][] = Array.from({ length: nodeCount }, () => []);
	for (let e = 0; e < edges.length; e++) {
		if (backEdges[e]) continue;
		if (edges[e].src === edges[e].dst) continue;
		fwdSuccs[edges[e].src].push(edges[e].dst);
		fwdPreds[edges[e].dst].push(edges[e].src);
	}
	const fwdGraph: ReadonlyGraph = {
		nodeCount,
		successors: (n) => fwdSuccs[n],
		predecessors: (n) => fwdPreds[n],
	};

	const idom = computeDominators(fwdGraph, root);
	const domTree = buildDominatorTree(idom, root);
	const dominatedSetSize = computeSubtreeSizes(domTree, root, nodeCount);

	const exits: number[] = [];
	for (let v = 0; v < nodeCount; v++) {
		if (fwdSuccs[v].length === 0 && dfsResult.preNum[v] !== UNDEFINED) {
			exits.push(v);
		}
	}
	if (exits.length === 0) exits.push(root);

	const virtualSink = nodeCount;
	const revNodeCount = nodeCount + 1;
	const revSuccs: number[][] = Array.from({ length: revNodeCount }, () => []);
	const revPreds: number[][] = Array.from({ length: revNodeCount }, () => []);

	for (let v = 0; v < nodeCount; v++) {
		for (const u of fwdSuccs[v]) {
			revSuccs[u].push(v);
			revPreds[v].push(u);
		}
	}
	for (const exit of exits) {
		revSuccs[virtualSink].push(exit);
		revPreds[exit].push(virtualSink);
	}

	const revGraph: ReadonlyGraph = {
		nodeCount: revNodeCount,
		successors: (n) => revSuccs[n],
		predecessors: (n) => revPreds[n],
	};
	const ipdomFull = computeDominators(revGraph, virtualSink);
	const ipdom = ipdomFull.slice(0, nodeCount) as Uint32Array;
	for (let v = 0; v < nodeCount; v++) {
		if (ipdom[v] === virtualSink) ipdom[v] = UNDEFINED;
	}

	const postDomDepthFull = dominatorDepth(ipdomFull, virtualSink);
	const postDomDepth = postDomDepthFull.slice(0, nodeCount) as Uint32Array;

	return { backEdges, idom, ipdom, dominatedSetSize, postDomDepth };
}

// ---------- VEIL ranking ----------

function veilRanking(
	nodeCount: number,
	root: number,
	edges: ReadonlyArray<{ src: number; dst: number }>,
	isFlipped: Uint8Array,
	selfLoopSet: Set<number>,
	analysis: CfgAnalysis,
): Int32Array {
	const { idom, ipdom, dominatedSetSize, postDomDepth } = analysis;

	const fwdSuccs: number[][] = Array.from({ length: nodeCount }, () => []);
	for (let e = 0; e < edges.length; e++) {
		if (selfLoopSet.has(e) || isFlipped[e]) continue;
		fwdSuccs[edges[e].src].push(edges[e].dst);
	}

	const incomingBack = new Map<number, number[]>();
	for (let e = 0; e < edges.length; e++) {
		if (!isFlipped[e] || selfLoopSet.has(e)) continue;
		const target = edges[e].dst;
		const source = edges[e].src;
		let arr = incomingBack.get(target);
		if (!arr) {
			arr = [];
			incomingBack.set(target, arr);
		}
		arr.push(source);
	}

	const rank = new Int32Array(nodeCount).fill(-1);
	const visited = new Uint8Array(nodeCount);

	const queue: Array<{ node: number; r: number }> = [{ node: root, r: 0 }];
	let head = 0;

	const enqueue = (node: number, r: number): void => {
		if (r > rank[node]) rank[node] = r;
		queue.push({ node, r });
	};

	const dominates = (a: number, b: number): boolean => {
		if (a === b) return true;
		let cur = b;
		while (cur !== UNDEFINED && cur !== a) {
			const next = idom[cur];
			if (next === cur) return false;
			cur = next;
		}
		return cur === a;
	};

	const postDominates = (a: number, b: number): boolean => {
		if (a === b) return true;
		let cur = b;
		while (cur !== UNDEFINED && cur !== a) {
			const next = ipdom[cur];
			if (next === cur) return false;
			cur = next;
		}
		return cur === a;
	};

	while (head < queue.length) {
		const { node: v, r } = queue[head++];
		if (r < rank[v]) continue;
		if (visited[v]) continue;
		visited[v] = 1;
		rank[v] = r;

		const succs = fwdSuccs[v];
		const backSources = incomingBack.get(v);

		let handledAsLoop = false;
		if (backSources && backSources.length > 0) {
			for (const u of backSources) {
				let allPostDom = true;
				for (const s of succs) {
					if (!postDominates(u, s)) {
						allPostDom = false;
						break;
					}
				}

				if (!allPostDom) {
					handledAsLoop = true;
					let exitNode = -1;
					let bestPostDomDepth = -1;
					for (const s of succs) {
						if (s === u) continue;
						if (dominates(s, u)) continue;
						const pd = postDomDepth[s] !== UNDEFINED ? postDomDepth[s] : 0;
						if (pd > bestPostDomDepth) {
							bestPostDomDepth = pd;
							exitNode = s;
						}
					}

					if (exitNode >= 0) {
						let bodySize = 0;
						const bodyVisited = new Uint8Array(nodeCount);
						const bodyStack = [v];
						bodyVisited[v] = 1;
						while (bodyStack.length > 0) {
							const cur = bodyStack.pop()!;
							bodySize++;
							for (const next of fwdSuccs[cur]) {
								if (next === exitNode) continue;
								if (bodyVisited[next]) continue;
								bodyVisited[next] = 1;
								bodyStack.push(next);
							}
						}

						const exitRank = rank[v] + bodySize + 1;
						if (exitRank > rank[exitNode]) rank[exitNode] = exitRank;
					}
				}
			}
		}

		if (!handledAsLoop && succs.length > 1) {
			const merge = ipdom[v];
			if (merge !== UNDEFINED && merge !== v) {
				const mergeSize =
					dominatedSetSize[merge] !== undefined ? dominatedSetSize[merge] : 0;
				const condSize = dominatedSetSize[v] - mergeSize;
				if (condSize > 0) {
					const mergeRank = rank[v] + condSize + 1;
					if (mergeRank > rank[merge]) rank[merge] = mergeRank;
				}
			}
		}

		for (const s of succs) {
			enqueue(s, rank[v] + 1);
		}
	}

	for (let v = 0; v < nodeCount; v++) {
		if (rank[v] < 0) rank[v] = 0;
	}

	const occupied = new Set<number>();
	for (let v = 0; v < nodeCount; v++) occupied.add(rank[v]);
	const sorted = Array.from(occupied).sort((a, b) => a - b);
	const remap = new Map<number, number>();
	for (let i = 0; i < sorted.length; i++) remap.set(sorted[i], i);

	const maxDense = sorted.length - 1;
	for (let v = 0; v < nodeCount; v++) {
		rank[v] = maxDense - remap.get(rank[v])!;
	}

	return rank;
}

// ---------- 2. Slide nodes ----------

function slideNodes(
	nodeCount: number,
	layer: Int32Array,
	succs: number[][],
	preds: number[][],
	heights: Float64Array,
	paddings: Float64Array,
): void {
	const candidates: {
		node: number;
		minLayer: number;
		maxLayer: number;
		height: number;
	}[] = [];

	for (let node = 0; node < nodeCount; node++) {
		const nodeLayer = layer[node];

		const neighborLayers: number[] = [];
		for (const s of succs[node]) neighborLayers.push(layer[s]);
		for (const p of preds[node]) neighborLayers.push(layer[p]);

		const smallerLayers = neighborLayers.filter((l) => l <= nodeLayer);
		const biggerLayers = neighborLayers.filter((l) => l >= nodeLayer);

		let lo = nodeLayer;
		if (smallerLayers.length > 0) {
			lo = Math.max(...smallerLayers) + 1;
		}

		let hi = nodeLayer;
		if (biggerLayers.length > 0) {
			hi = Math.min(...biggerLayers) - 1;
		}

		if (lo === hi) continue;

		candidates.push({
			node,
			minLayer: lo,
			maxLayer: hi,
			height: heights[node],
		});
	}

	candidates.sort((a, b) => b.height - a.height);

	const computeGraphHeight = (): number => {
		let maxL = 0;
		for (let i = 0; i < nodeCount; i++) if (layer[i] > maxL) maxL = layer[i];

		let y = 0;
		for (let l = maxL; l >= 0; l--) {
			let layerHeight = 0;
			let layerGap = 2 * Y_GUTTER;

			for (let i = 0; i < nodeCount; i++) {
				if (layer[i] !== l) continue;
				const padH =
					paddings[i * PAD_STRIDE + PAD_TOP] +
					paddings[i * PAD_STRIDE + PAD_BOTTOM];
				const h = heights[i] + padH;
				if (h > layerHeight) layerHeight = h;
				layerGap += succs[i].length * EDGE_HEIGHT;
			}

			if (layerGap === 2 * Y_GUTTER) layerGap = 0;
			y += layerHeight + layerGap;
		}

		return y;
	};

	for (const candidate of candidates) {
		const { node, minLayer, maxLayer } = candidate;
		const origLayer = layer[node];

		let bestHeight = computeGraphHeight();
		let bestLayer = origLayer;

		for (let r = minLayer; r <= maxLayer; r++) {
			if (r === origLayer) continue;
			layer[node] = r;
			const h = computeGraphHeight();
			if (h < bestHeight) {
				bestHeight = h;
				bestLayer = r;
			}
		}

		layer[node] = bestLayer;
	}
}

// ---------- Expanded graph ----------

type ExpandedEdge = {
	from: number;
	to: number;
	waypoints: [Point, Point, Point, Point];
	weight: number;
	startXOffset: number;
	endXOffset: number;
};

type ExpandedGraph = {
	nodeCount: number;
	layerCount: number;
	realNodeCount: number;
	layer: Int32Array;
	widths: Float64Array;
	heights: Float64Array;
	paddings: Float64Array;
	isDummy: Uint8Array;
	priorities: Uint8Array;
	succs: number[][];
	succEdgeIds: number[][];
	preds: number[][];
	predEdgeIds: number[][];
	edges: ExpandedEdge[];
	edgeFromTo: Map<string, number>;
	originalEdgeToExpanded: Int32Array;
	deletedOriginalEdges: Map<number, number[]>;
	selfLoopEdges: Set<number>;
	selfLoopWaypoints: Map<number, Point[]>;
	deletedEdgeWaypoints: Map<number[], Point[]>;
	hasTopLoop: boolean;
	hasBottomLoop: boolean;
	ioEdges: Map<string, number>;
	ioEdgeChains: Map<string, number[]>;
};

function removeExpandedAdjacency(
	succs: number[][],
	succEdgeIds: number[][],
	preds: number[][],
	predEdgeIds: number[][],
	edgeId: number,
	from: number,
	to: number,
): void {
	const outIds = succEdgeIds[from];
	const outIdx = outIds.indexOf(edgeId);
	if (outIdx !== -1) {
		outIds.splice(outIdx, 1);
		succs[from].splice(outIdx, 1);
	}

	const inIds = predEdgeIds[to];
	const inIdx = inIds.indexOf(edgeId);
	if (inIdx !== -1) {
		inIds.splice(inIdx, 1);
		preds[to].splice(inIdx, 1);
	}
}

function addExpandedAdjacency(
	succs: number[][],
	succEdgeIds: number[][],
	preds: number[][],
	predEdgeIds: number[][],
	edgeId: number,
	from: number,
	to: number,
): void {
	succs[from].push(to);
	succEdgeIds[from].push(edgeId);
	preds[to].push(from);
	predEdgeIds[to].push(edgeId);
}

// ---------- 4. remove_long_edges ----------

function buildExpandedGraph(
	realNodeCount: number,
	origEdges: ReadonlyArray<{ src: number; dst: number }>,
	isFlipped: Uint8Array,
	selfLoopEdges: Set<number>,
	origLayer: Int32Array,
	nodeWidths: Float64Array,
	nodeHeights: Float64Array,
	origPaddings: Float64Array,
	entries?: IOPair[],
	exits?: IOPair[],
	startXOffsets?: Float64Array,
	endXOffsets?: Float64Array,
): ExpandedGraph {
	const ioEntries = entries ?? [];
	const ioExits = exits ?? [];
	const ioGhostCount = ioEntries.length + ioExits.length;
	const initialStartXOffsets =
		startXOffsets ?? new Float64Array(origEdges.length).fill(-1);
	const initialEndXOffsets =
		endXOffsets ?? new Float64Array(origEdges.length).fill(-1);
	const hasIo = ioEntries.length > 0 || ioExits.length > 0;

	let baseMaxLayer = 0;
	for (let i = 0; i < realNodeCount; i++) {
		if (origLayer[i] > baseMaxLayer) baseMaxLayer = origLayer[i];
	}
	const baseLayerCount = baseMaxLayer + 1;
	const ioTopLayer = baseLayerCount;

	const chainDummyCount = (
		fromLayer: number,
		toLayer: number,
		flipped: boolean,
	): number => {
		const bottomLayer = Math.min(fromLayer, toLayer);
		const topLayer = Math.max(fromLayer, toLayer);

		if (topLayer - bottomLayer <= 1 && !flipped) {
			return 0;
		}

		const isGoingUp =
			(flipped && fromLayer !== bottomLayer) ||
			(!flipped && fromLayer === bottomLayer);

		let lo = bottomLayer;
		let hi = topLayer;
		if (isGoingUp) {
			lo -= 2;
			hi += 2;
		}

		const count = hi - lo - 1;
		return count > 0 ? count : 0;
	};

	let dummyNeeded = 0;
	for (let e = 0; e < origEdges.length; e++) {
		if (selfLoopEdges.has(e)) continue;
		const flipped = !!isFlipped[e];
		const dagSrc = flipped ? origEdges[e].dst : origEdges[e].src;
		const dagDst = flipped ? origEdges[e].src : origEdges[e].dst;
		dummyNeeded += chainDummyCount(
			origLayer[dagSrc],
			origLayer[dagDst],
			flipped,
		);
	}
	if (hasIo) {
		for (const entry of ioEntries) {
			dummyNeeded += chainDummyCount(ioTopLayer, origLayer[entry.node], false);
		}
		for (const exit of ioExits) {
			dummyNeeded += chainDummyCount(origLayer[exit.node], 0, false);
		}
	}

	const totalNodes = realNodeCount + dummyNeeded + ioGhostCount;
	const layer = new Int32Array(totalNodes);
	const isDummy = new Uint8Array(totalNodes);
	const widths = new Float64Array(totalNodes);
	const heights = new Float64Array(totalNodes);
	const priorities = new Uint8Array(totalNodes);
	const paddings = new Float64Array(totalNodes * PAD_STRIDE);
	const succs: number[][] = Array.from({ length: totalNodes }, () => []);
	const succEdgeIds: number[][] = Array.from({ length: totalNodes }, () => []);
	const preds: number[][] = Array.from({ length: totalNodes }, () => []);
	const predEdgeIds: number[][] = Array.from({ length: totalNodes }, () => []);

	for (let i = 0; i < realNodeCount; i++) {
		layer[i] = origLayer[i];
		widths[i] = nodeWidths[i];
		heights[i] = nodeHeights[i];
		paddings[i * PAD_STRIDE + PAD_TOP] = origPaddings[i * PAD_STRIDE + PAD_TOP];
		paddings[i * PAD_STRIDE + PAD_BOTTOM] =
			origPaddings[i * PAD_STRIDE + PAD_BOTTOM];
		paddings[i * PAD_STRIDE + PAD_LEFT] =
			origPaddings[i * PAD_STRIDE + PAD_LEFT];
		paddings[i * PAD_STRIDE + PAD_RIGHT] =
			origPaddings[i * PAD_STRIDE + PAD_RIGHT];
	}
	for (let i = realNodeCount; i < totalNodes; i++) {
		isDummy[i] = 1;
		widths[i] = WAYPOINT_WIDTH;
		heights[i] = WAYPOINT_HEIGHT;
		priorities[i] = WAYPOINT_PRIORITY;
		paddings[i * PAD_STRIDE + PAD_LEFT] = X_GUTTER;
		paddings[i * PAD_STRIDE + PAD_RIGHT] = X_GUTTER;
	}

	const expandedEdges: ExpandedEdge[] = [];
	const edgeFromTo = new Map<string, number>();
	const originalEdgeToExpanded = new Int32Array(origEdges.length).fill(-1);
	const deletedOriginalEdges = new Map<number, number[]>();
	const ioEdges = new Map<string, number>();
	const ioEdgeChains = new Map<string, number[]>();
	let nextNode = realNodeCount;

	const addEdge = (
		from: number,
		to: number,
		weight = 1,
		startXOff = -1,
		endXOff = -1,
	): number => {
		const idx = expandedEdges.length;
		expandedEdges.push({
			from,
			to,
			waypoints: [
				{ x: 0, y: 0 },
				{ x: 0, y: 0 },
				{ x: 0, y: 0 },
				{ x: 0, y: 0 },
			],
			weight,
			startXOffset: startXOff,
			endXOffset: endXOff,
		});
		edgeFromTo.set(`${from},${to}`, idx);
		addExpandedAdjacency(succs, succEdgeIds, preds, predEdgeIds, idx, from, to);
		return idx;
	};

	let hasTopLoop = false;
	let hasBottomLoop = false;

	const setLayer = (node: number, l: number): void => {
		layer[node] = l;
		if (l === ioTopLayer) hasTopLoop = true;
		if (l === 0) hasBottomLoop = true;
	};

	type PendingEdge = {
		from: number;
		to: number;
		flipped: boolean;
		originalEdge: number;
		ioKey: string | null;
		startXOffset: number;
		endXOffset: number;
	};

	const pendingEdges: PendingEdge[] = [];
	for (let e = 0; e < origEdges.length; e++) {
		if (selfLoopEdges.has(e)) continue;
		const flipped = !!isFlipped[e];
		pendingEdges.push({
			from: flipped ? origEdges[e].dst : origEdges[e].src,
			to: flipped ? origEdges[e].src : origEdges[e].dst,
			flipped,
			originalEdge: e,
			ioKey: null,
			startXOffset: initialStartXOffsets[e] ?? -1,
			endXOffset: initialEndXOffsets[e] ?? -1,
		});
	}

	if (hasIo) {
		for (const entry of ioEntries) {
			const ghost = nextNode++;
			setLayer(ghost, ioTopLayer);
			pendingEdges.push({
				from: ghost,
				to: entry.node,
				flipped: false,
				originalEdge: -1,
				ioKey: `${entry.node},${entry.edge}`,
				startXOffset: -1,
				endXOffset: -1,
			});
		}

		for (const exit of ioExits) {
			const ghost = nextNode++;
			setLayer(ghost, 0);
			pendingEdges.push({
				from: exit.node,
				to: ghost,
				flipped: false,
				originalEdge: -1,
				ioKey: `${exit.node},${exit.edge}`,
				startXOffset: -1,
				endXOffset: -1,
			});
		}
	}

	const reverseChainEdges = (chainEdgeIds: number[]): void => {
		chainEdgeIds.reverse();
		for (const edgeId of chainEdgeIds) {
			const edge = expandedEdges[edgeId];
			const oldFrom = edge.from;
			const oldTo = edge.to;

			removeExpandedAdjacency(
				succs,
				succEdgeIds,
				preds,
				predEdgeIds,
				edgeId,
				oldFrom,
				oldTo,
			);

			edge.from = oldTo;
			edge.to = oldFrom;

			addExpandedAdjacency(
				succs,
				succEdgeIds,
				preds,
				predEdgeIds,
				edgeId,
				oldTo,
				oldFrom,
			);

			edgeFromTo.delete(`${oldFrom},${oldTo}`);
			edgeFromTo.set(`${oldTo},${oldFrom}`, edgeId);
		}
	};

	for (const pendingEdge of pendingEdges) {
		const fromLayer = layer[pendingEdge.from];
		const toLayer = layer[pendingEdge.to];
		const bottomLayer = Math.min(fromLayer, toLayer);
		const topLayer = Math.max(fromLayer, toLayer);

		if (topLayer - bottomLayer <= 1 && !pendingEdge.flipped) {
			const edgeId = addEdge(
				pendingEdge.from,
				pendingEdge.to,
				1,
				pendingEdge.startXOffset,
				pendingEdge.endXOffset,
			);
			if (pendingEdge.originalEdge >= 0) {
				originalEdgeToExpanded[pendingEdge.originalEdge] = edgeId;
			}
			if (pendingEdge.ioKey !== null) {
				ioEdges.set(pendingEdge.ioKey, edgeId);
			}
			continue;
		}

		const isGoingUp =
			(pendingEdge.flipped && fromLayer !== bottomLayer) ||
			(!pendingEdge.flipped && fromLayer === bottomLayer);

		let lo = bottomLayer;
		let hi = topLayer;
		if (isGoingUp) {
			lo -= 2;
			hi += 2;
		}

		const bottom =
			bottomLayer === fromLayer ? pendingEdge.from : pendingEdge.to;
		const top = topLayer === toLayer ? pendingEdge.to : pendingEdge.from;

		let previousPoint = bottom;
		const chainEdgeIds: number[] = [];

		const dummyKind =
			pendingEdge.flipped && veilConfig.enabled && veilConfig.dummyTagging
				? DUMMY_BACK
				: 1;

		for (let l = lo + 1; l < hi; l++) {
			const ghost = nextNode++;
			setLayer(ghost, l);
			if (dummyKind === DUMMY_BACK) isDummy[ghost] = DUMMY_BACK;

			const weight = isGoingUp && l === lo + 1 ? 0 : 1;
			chainEdgeIds.push(addEdge(ghost, previousPoint, weight));
			previousPoint = ghost;
		}

		chainEdgeIds.push(addEdge(top, previousPoint, isGoingUp ? 0 : 1));

		if (!isGoingUp) {
			reverseChainEdges(chainEdgeIds);
		}

		if (pendingEdge.originalEdge >= 0) {
			deletedOriginalEdges.set(pendingEdge.originalEdge, chainEdgeIds);
		} else if (pendingEdge.ioKey !== null) {
			ioEdgeChains.set(pendingEdge.ioKey, chainEdgeIds);
		}
	}

	let minLayer = 0;
	let maxLayer = 0;
	for (let i = 0; i < nextNode; i++) {
		if (layer[i] < minLayer) minLayer = layer[i];
		if (layer[i] > maxLayer) maxLayer = layer[i];
	}
	if (minLayer < 0) {
		for (let i = 0; i < nextNode; i++) {
			layer[i] -= minLayer;
		}
		maxLayer -= minLayer;
	}

	const layerCount = maxLayer + 1;
	if (hasIo) {
		hasTopLoop = true;
		hasBottomLoop = true;
	}

	return {
		nodeCount: nextNode,
		layerCount,
		realNodeCount,
		layer,
		widths,
		heights,
		paddings,
		isDummy,
		priorities,
		succs,
		succEdgeIds,
		preds,
		predEdgeIds,
		edges: expandedEdges,
		edgeFromTo,
		originalEdgeToExpanded,
		deletedOriginalEdges,
		selfLoopEdges,
		selfLoopWaypoints: new Map(),
		deletedEdgeWaypoints: new Map(),
		hasTopLoop,
		hasBottomLoop,
		ioEdges,
		ioEdgeChains,
	};
}

// ---------- 6. Flip edges so all point from high layer to low ----------

function flipExpandedEdges(g: ExpandedGraph): void {
	for (let edgeId = 0; edgeId < g.edges.length; edgeId++) {
		const edge = g.edges[edgeId];
		if (g.layer[edge.from] >= g.layer[edge.to]) continue;

		const oldFrom = edge.from;
		const oldTo = edge.to;
		removeExpandedAdjacency(
			g.succs,
			g.succEdgeIds,
			g.preds,
			g.predEdgeIds,
			edgeId,
			oldFrom,
			oldTo,
		);

		edge.from = oldTo;
		edge.to = oldFrom;

		addExpandedAdjacency(
			g.succs,
			g.succEdgeIds,
			g.preds,
			g.predEdgeIds,
			edgeId,
			oldTo,
			oldFrom,
		);
	}

	g.edgeFromTo.clear();
	for (let i = 0; i < g.edges.length; i++) {
		g.edgeFromTo.set(`${g.edges[i].from},${g.edges[i].to}`, i);
	}
}

// ---------- 7. Y coordinate assignment ----------

function yCoordinateAssignment(
	g: ExpandedGraph,
	nodeLayers: number[][],
): Float64Array {
	const ys = new Float64Array(g.nodeCount);
	let y = 0;

	for (let l = g.layerCount - 1; l >= 0; l--) {
		const nodesInLayer = nodeLayers[l];

		let layerHeight = 0;
		for (const node of nodesInLayer) {
			if (g.heights[node] > layerHeight) layerHeight = g.heights[node];
		}

		let layerGap = 2 * Y_GUTTER;
		for (const node of nodesInLayer)
			layerGap += g.succs[node].length * EDGE_HEIGHT;

		if (layerGap === 2 * Y_GUTTER) layerGap = 0;

		for (const node of nodesInLayer) ys[node] = y;

		y += layerHeight + layerGap;
	}

	return ys;
}

// ---------- 8. Vertex ordering ----------

function buildAdjacencyCSR(adj: number[][]): {
	offs: Int32Array;
	data: Int32Array;
} {
	const offs = new Int32Array(adj.length + 1);
	for (let i = 0; i < adj.length; i++) offs[i + 1] = offs[i] + adj[i].length;
	const data = new Int32Array(offs[adj.length]);
	for (let i = 0; i < adj.length; i++) {
		const start = offs[i];
		const arr = adj[i];
		for (let k = 0; k < arr.length; k++) data[start + k] = arr[k];
	}
	return { offs, data };
}

function veilDummySortKey(isDummy: Uint8Array, node: number): number {
	if (isDummy[node] === DUMMY_BACK) return 0;
	if (isDummy[node] === 0) return 1;
	return 2;
}

function vertexOrdering(g: ExpandedGraph, nodeLayers: number[][]): number[][] {
	const lc = g.layerCount;
	const rng = new DeterministicRng();

	const nodeLayersCopy: number[][] = Array.from({ length: lc }, (_, l) =>
		nodeLayers[l].slice(),
	);

	const ord = new Float64Array(g.nodeCount).fill(-1);

	const veilOrdering = veilConfig.enabled && veilConfig.ordering;
	if (veilOrdering) {
		for (let l = 0; l < lc; l++) {
			nodeLayersCopy[l].sort(
				(a, b) =>
					veilDummySortKey(g.isDummy, a) - veilDummySortKey(g.isDummy, b),
			);
			for (let i = 0; i < nodeLayersCopy[l].length; i++)
				ord[nodeLayersCopy[l][i]] = i;
		}
	} else {
		for (let l = 0; l < lc; l++)
			for (let i = 0; i < nodeLayersCopy[l].length; i++)
				ord[nodeLayersCopy[l][i]] = i;
	}

	const normalize = () => {
		for (let l = 0; l < lc; l++) {
			shuffleArray(nodeLayersCopy[l], rng);
			nodeLayersCopy[l].sort((a, b) => ord[a] - ord[b]);
			for (let i = 0; i < nodeLayersCopy[l].length; i++)
				ord[nodeLayersCopy[l][i]] = i;
		}
	};

	normalize();

	const predCSR = buildAdjacencyCSR(g.preds);
	const succCSR = buildAdjacencyCSR(g.succs);
	const topSorted = new Int32Array(predCSR.data.length);
	const botSorted = new Int32Array(succCSR.data.length);

	let maxDeg = 0;
	for (let v = 0; v < g.nodeCount; v++) {
		const pn = predCSR.offs[v + 1] - predCSR.offs[v];
		const sn = succCSR.offs[v + 1] - succCSR.offs[v];
		if (pn > maxDeg) maxDeg = pn;
		if (sn > maxDeg) maxDeg = sn;
	}
	const medianScratch = new Float64Array(Math.max(1, maxDeg));

	let bestCrossings: number = 0xffffffff;
	const bestOrd = new Float64Array(ord);

	for (let i = 0; i < 24; i++) {
		median(
			nodeLayersCopy,
			ord,
			predCSR,
			succCSR,
			medianScratch,
			i,
			veilOrdering ? g.isDummy : undefined,
		);
		normalize();
		if (veilOrdering) {
			for (let l = 0; l < lc; l++) {
				for (let j = 0; j < nodeLayersCopy[l].length; j++) {
					const n = nodeLayersCopy[l][j];
					if (g.isDummy[n] === DUMMY_BACK) ord[n] = j;
				}
			}
		}
		if (i !== 0) {
			transpose(nodeLayersCopy, ord, predCSR, succCSR, topSorted, botSorted);
		}

		const newCrossings = countAllCrossings(g, nodeLayersCopy, ord);
		// console.log(
		// 	`Iteration ${i}, crossings: ${newCrossings} (best: ${bestCrossings}) improvement %: ${((bestCrossings - newCrossings) / bestCrossings) * 100}`,
		// );
		if (newCrossings < bestCrossings) {
			bestOrd.set(ord);
			bestCrossings = newCrossings;
			if (newCrossings === 0) break;
		}
	}

	if (veilOrdering && bestCrossings > 0) {
		ord.set(bestOrd);
		for (let l = 0; l < lc; l++) {
			nodeLayersCopy[l].sort((a, b) => ord[a] - ord[b]);
			for (let i = 0; i < nodeLayersCopy[l].length; i++)
				ord[nodeLayersCopy[l][i]] = i;
		}

		for (let i = 0; i < 8; i++) {
			veilBackDummyMedian(
				nodeLayersCopy,
				ord,
				g.isDummy,
				predCSR,
				succCSR,
				medianScratch,
				i,
			);
			normalize();
			for (let l = 0; l < lc; l++) {
				for (let j = 0; j < nodeLayersCopy[l].length; j++) {
					const n = nodeLayersCopy[l][j];
					if (g.isDummy[n] !== DUMMY_BACK) ord[n] = j;
				}
			}

			const newCrossings = countAllCrossings(g, nodeLayersCopy, ord);
			if (newCrossings < bestCrossings) {
				bestOrd.set(ord);
				bestCrossings = newCrossings;
				if (newCrossings === 0) break;
			}
		}
	}

	ord.set(bestOrd);
	for (let l = 0; l < lc; l++) {
		nodeLayersCopy[l].sort((a, b) => ord[a] - ord[b]);
		for (let i = 0; i < nodeLayersCopy[l].length; i++)
			ord[nodeLayersCopy[l][i]] = i;
	}

	return nodeLayersCopy;
}

function shuffleArray(arr: number[], rng: DeterministicRng): void {
	for (let i = arr.length - 1; i > 0; i--) {
		const j = Math.floor(rng.next() * (i + 1));
		const tmp = arr[i];
		arr[i] = arr[j];
		arr[j] = tmp;
	}
}

function median(
	nodeLayersCopy: number[][],
	ord: Float64Array,
	predCSR: { offs: Int32Array; data: Int32Array },
	succCSR: { offs: Int32Array; data: Int32Array },
	scratch: Float64Array,
	iter: number,
	isDummy?: Uint8Array,
): void {
	const csr = iter % 2 === 0 ? succCSR : predCSR;
	for (const nodes of nodeLayersCopy) {
		for (const node of nodes) {
			if (isDummy && isDummy[node] === DUMMY_BACK) continue;
			const s = csr.offs[node];
			const e = csr.offs[node + 1];
			const n = e - s;
			if (n === 0) continue;
			for (let k = 0; k < n; k++) scratch[k] = ord[csr.data[s + k]];
			for (let k = 1; k < n; k++) {
				const x = scratch[k];
				let j = k - 1;
				while (j >= 0 && scratch[j] > x) {
					scratch[j + 1] = scratch[j];
					j--;
				}
				scratch[j + 1] = x;
			}
			ord[node] = scratch[n >> 1];
		}
	}
}

function veilBackDummyMedian(
	nodeLayersCopy: number[][],
	ord: Float64Array,
	isDummy: Uint8Array,
	predCSR: { offs: Int32Array; data: Int32Array },
	succCSR: { offs: Int32Array; data: Int32Array },
	scratch: Float64Array,
	iter: number,
): void {
	const csr = iter % 2 === 0 ? succCSR : predCSR;
	for (const nodes of nodeLayersCopy) {
		for (const node of nodes) {
			if (isDummy[node] !== DUMMY_BACK) continue;
			const s = csr.offs[node];
			const e = csr.offs[node + 1];
			const n = e - s;
			if (n === 0) continue;
			for (let k = 0; k < n; k++) scratch[k] = ord[csr.data[s + k]];
			for (let k = 1; k < n; k++) {
				const x = scratch[k];
				let j = k - 1;
				while (j >= 0 && scratch[j] > x) {
					scratch[j + 1] = scratch[j];
					j--;
				}
				scratch[j + 1] = x;
			}
			ord[node] = scratch[n >> 1];
		}
	}
}

// Swapping v and w within their own layer never changes ord[x] for x in
// adjacent layers, so sorted neighbor lists can be cached for the duration of
// one layer pass and reused for every adjacent pair in that layer. Both
// pairCrossings(v,w) and pairCrossings(w,v) share the same cached neighbor
// ranges and are computed with a single pair of inversion counts.
function sortNeighborRange(buf: Int32Array, start: number, end: number): void {
	for (let i = start + 1; i < end; i++) {
		const x = buf[i];
		let j = i - 1;
		while (j >= start && buf[j] > x) {
			buf[j + 1] = buf[j];
			j--;
		}
		buf[j + 1] = x;
	}
}

function refreshSortedNeighbors(
	nodes: number[],
	ord: Float64Array,
	csr: { offs: Int32Array; data: Int32Array },
	out: Int32Array,
): void {
	const offs = csr.offs;
	const data = csr.data;
	for (const v of nodes) {
		const s = offs[v];
		const e = offs[v + 1];
		for (let i = s; i < e; i++) out[i] = ord[data[i]];
		if (e - s > 1) sortNeighborRange(out, s, e);
	}
}

function countInversionsRange(
	buf: Int32Array,
	as_: number,
	ae: number,
	bs: number,
	be: number,
): number {
	let inv = 0;
	let i = as_;
	let j = bs;
	while (i < ae && j < be) {
		if (buf[i] > buf[j]) {
			j++;
			inv += ae - i;
		} else {
			i++;
		}
	}
	return inv;
}

function transpose(
	nodeLayersCopy: number[][],
	ord: Float64Array,
	predCSR: { offs: Int32Array; data: Int32Array },
	succCSR: { offs: Int32Array; data: Int32Array },
	topSorted: Int32Array,
	botSorted: Int32Array,
): void {
	let improved = true;
	let transposeIter = 0;
	const maxTransposeIter = nodeLayersCopy.length * 4;
	while (improved && transposeIter++ < maxTransposeIter) {
		improved = false;
		for (const nodes of nodeLayersCopy) {
			if (nodes.length < 2) continue;
			refreshSortedNeighbors(nodes, ord, predCSR, topSorted);
			refreshSortedNeighbors(nodes, ord, succCSR, botSorted);

			const topOffs = predCSR.offs;
			const botOffs = succCSR.offs;
			for (let i = 0; i < nodes.length - 1; i++) {
				const v = nodes[i];
				const w = nodes[i + 1];
				const tvs = topOffs[v];
				const tve = topOffs[v + 1];
				const tws = topOffs[w];
				const twe = topOffs[w + 1];
				const bvs = botOffs[v];
				const bve = botOffs[v + 1];
				const bws = botOffs[w];
				const bwe = botOffs[w + 1];

				let crossings = 0;
				let newCrossings = 0;

				const tm = tve - tvs;
				const tn = twe - tws;
				if (tm === 1 && tn === 1) {
					const a = topSorted[tvs],
						b = topSorted[tws];
					if (a > b) crossings = 1;
					else if (a < b) newCrossings = 1;
				} else if (tm > 0 && tn > 0) {
					crossings = countInversionsRange(topSorted, tvs, tve, tws, twe);
					newCrossings = countInversionsRange(topSorted, tws, twe, tvs, tve);
				}

				const bm = bve - bvs;
				const bn = bwe - bws;
				if (bm === 1 && bn === 1) {
					const a = botSorted[bvs],
						b = botSorted[bws];
					if (a > b) crossings++;
					else if (a < b) newCrossings++;
				} else if (bm > 0 && bn > 0) {
					crossings += countInversionsRange(botSorted, bvs, bve, bws, bwe);
					newCrossings += countInversionsRange(botSorted, bws, bwe, bvs, bve);
				}

				if (newCrossings <= crossings) {
					if (newCrossings < crossings) improved = true;
					ord[v] = i + 1;
					ord[w] = i;
					nodes[i] = w;
					nodes[i + 1] = v;
				}
			}
		}
	}
}

function countAllCrossings(
	g: ExpandedGraph,
	nodeLayersCopy: number[][],
	ord: Float64Array,
): number {
	let crossings = 0;
	for (let l = 0; l < nodeLayersCopy.length - 1; l++) {
		crossings += countCrossingsWithLayer(g, nodeLayersCopy, ord, l, l + 1);
	}
	return crossings;
}

function countCrossingsWithLayer(
	g: ExpandedGraph,
	nodeLayersCopy: number[][],
	ord: Float64Array,
	l1: number,
	l2: number,
): number {
	const layerNodes = nodeLayersCopy[l1];
	if (layerNodes.length <= 1) return 0;

	const orders: number[] = [];
	for (const node of layerNodes) {
		const neighbors: number[] = [];
		for (const c of g.succs[node]) {
			if (g.layer[c] === l2) neighbors.push(ord[c]);
		}
		for (const p of g.preds[node]) {
			if (g.layer[p] === l2) neighbors.push(ord[p]);
		}
		neighbors.sort((a, b) => a - b);
		for (const n of neighbors) orders.push(n);
	}

	return sortAndCount(orders, 0, orders.length);
}

function sortAndCount(arr: number[], lo: number, hi: number): number {
	if (hi - lo <= 1) return 0;
	const mid = lo + ((hi - lo) >> 1);
	let inversions = sortAndCount(arr, lo, mid);
	inversions += sortAndCount(arr, mid, hi);
	inversions += mergeAndCount(arr, lo, mid, hi);
	return inversions;
}

function mergeAndCount(
	arr: number[],
	lo: number,
	mid: number,
	hi: number,
): number {
	const loArr = arr.slice(lo, mid);
	const hiArr = arr.slice(mid, hi);
	const loSz = mid - lo;
	const hiSz = hi - mid;

	let i = 0;
	let j = 0;
	let k = lo;
	let inversions = 0;

	while (i < loSz && j < hiSz) {
		if (loArr[i] <= hiArr[j]) {
			arr[k++] = loArr[i++];
		} else {
			arr[k++] = hiArr[j++];
			inversions += loSz - i;
		}
	}

	while (i < loSz) arr[k++] = loArr[i++];
	while (j < hiSz) arr[k++] = hiArr[j++];

	return inversions;
}

// ---------- 9. Waypoint creation ----------

function waypointCreation(
	g: ExpandedGraph,
	order: number[][],
	position: Int32Array,
	ys: Float64Array,
): void {
	for (const edge of g.edges) {
		edge.waypoints = [
			{ x: 0, y: 0 },
			{ x: 0, y: 0 },
			{ x: 0, y: 0 },
			{ x: 0, y: 0 },
		];
	}

	for (let l = 0; l < g.layerCount; l++) {
		const nodes = order[l].slice();

		for (const node of nodes) {
			const y0 = ys[node] + g.heights[node];

			const childEdges = g.succEdgeIds[node].slice();

			childEdges.sort((a, b) => {
				const orderA = position[g.edges[a].to];
				const orderB = position[g.edges[b].to];
				if (orderA === orderB) {
					return g.edges[a].endXOffset - g.edges[b].endXOffset;
				}
				return orderA - orderB;
			});

			const spacer = g.widths[node] / (childEdges.length + 1);
			let x = spacer;

			for (const eidx of childEdges) {
				const wp = g.edges[eidx].waypoints;

				if (g.edges[eidx].startXOffset < 0) {
					wp[0].x = x;
					wp[1].x = x;
					g.edges[eidx].startXOffset = x;
				} else {
					wp[0].x = g.edges[eidx].startXOffset;
					wp[1].x = g.edges[eidx].startXOffset;
				}

				wp[0].y = y0;
				wp[3].y = ys[g.edges[eidx].to];

				x += spacer;
			}
		}

		for (const node of nodes) {
			const parentEdges = g.predEdgeIds[node].slice();

			parentEdges.sort((a, b) => {
				const orderA = position[g.edges[a].from];
				const orderB = position[g.edges[b].from];
				if (orderA === orderB) {
					return g.edges[a].startXOffset - g.edges[b].startXOffset;
				}
				return orderA - orderB;
			});

			const spacer = g.widths[node] / (parentEdges.length + 1);
			let x = spacer;

			for (const eidx of parentEdges) {
				const wp = g.edges[eidx].waypoints;

				if (g.edges[eidx].endXOffset < 0) {
					wp[2].x = x;
					wp[3].x = x;
					g.edges[eidx].endXOffset = x;
				} else {
					wp[2].x = g.edges[eidx].endXOffset;
					wp[3].x = g.edges[eidx].endXOffset;
				}

				x += spacer;
			}
		}
	}
}

// ---------- 10. X coordinate assignment ----------

function xCoordinateAssignment(
	g: ExpandedGraph,
	nodeLayers: number[][],
	_order: number[][],
): Float64Array {
	const xs = new Float64Array(g.nodeCount);

	for (let l = 0; l < g.layerCount; l++) {
		const nodes = nodeLayers[l];
		let x = 0;
		let passedBackDummies = false;
		for (const node of nodes) {
			if (
				veilConfig.enabled &&
				veilConfig.gutter &&
				!passedBackDummies &&
				g.isDummy[node] !== DUMMY_BACK
			) {
				passedBackDummies = true;
				x += X_GUTTER;
			}
			x += g.paddings[node * PAD_STRIDE + PAD_LEFT];
			xs[node] = x;
			x += g.widths[node] + g.paddings[node * PAD_STRIDE + PAD_RIGHT];
		}
	}

	const graphWidth = computeGraphWidth(g, nodeLayers);

	for (let i = 0; i < 5; i++) {
		for (let r = 1; r < g.layerCount; r++) {
			coordinateAssignmentIteration(g, nodeLayers, xs, r, r - 1, graphWidth);
		}
		for (let r = g.layerCount - 1; r >= 0; r--) {
			coordinateAssignmentIteration(g, nodeLayers, xs, r, r + 1, graphWidth);
		}
	}

	for (let r = 1; r < g.layerCount; r++) {
		coordinateAssignmentIteration(g, nodeLayers, xs, r, r - 1, graphWidth);
	}

	return xs;
}

function computeGraphWidth(g: ExpandedGraph, nodeLayers: number[][]): number {
	let graphWidth = 0;
	for (const layerArr of nodeLayers) {
		let layerWidth = 0;
		for (const node of layerArr) {
			const padW =
				g.paddings[node * PAD_STRIDE + PAD_LEFT] +
				g.paddings[node * PAD_STRIDE + PAD_RIGHT];
			layerWidth += g.widths[node] + padW;
		}
		if (layerWidth > graphWidth) graphWidth = layerWidth;
	}
	return graphWidth;
}

function computeExpandedGraphHeight(
	g: ExpandedGraph,
	nodeLayers: number[][],
): number {
	let y = 0;

	if (g.hasTopLoop) {
		y -= 2 * Y_GUTTER;
	}

	for (let l = g.layerCount - 1; l >= 0; l--) {
		let layerHeight = 0;
		let layerGap = 2 * Y_GUTTER;

		for (const node of nodeLayers[l]) {
			const padH =
				g.paddings[node * PAD_STRIDE + PAD_TOP] +
				g.paddings[node * PAD_STRIDE + PAD_BOTTOM];
			const height = g.heights[node] + padH;
			if (height > layerHeight) layerHeight = height;
			layerGap += g.succs[node].length * EDGE_HEIGHT;
		}

		if (layerGap === 2 * Y_GUTTER) {
			layerGap = 0;
		}

		y += layerHeight + layerGap;
	}

	if (g.hasBottomLoop) {
		y -= 2 * Y_GUTTER;
	}

	return y;
}

function coordinateAssignmentIteration(
	g: ExpandedGraph,
	nodeLayers: number[][],
	xs: Float64Array,
	layerIdx: number,
	nextLayerIdx: number,
	graphWidth: number,
): void {
	const nodes = nodeLayers[layerIdx];
	if (nodes.length === 0) return;

	const sortedIndexes = Array.from({ length: nodes.length }, (_, i) => i);
	sortedIndexes.sort((a, b) => g.priorities[nodes[b]] - g.priorities[nodes[a]]);

	for (const i of sortedIndexes) {
		const node = nodes[i];

		let lo = minX(g, nodes, i, xs);
		let hi = maxX(g, nodes, i, xs, graphWidth);

		if (Math.abs(hi - lo) < 0.01) {
			hi = lo;
		}

		if (lo > hi) {
			lo = (lo + hi) / 2;
			hi = lo;
		}

		const avg = averagePosition(
			g,
			node,
			nextLayerIdx,
			nextLayerIdx < layerIdx,
			xs,
		);

		if (avg >= 0) {
			xs[node] = Math.max(lo, Math.min(hi, avg));
		} else {
			xs[node] = Math.max(lo, Math.min(hi, xs[node]));
		}
	}
}

function minX(
	g: ExpandedGraph,
	nodes: number[],
	id: number,
	xs: Float64Array,
): number {
	const priority = g.priorities[nodes[id]];
	let w = 0;

	for (let i = id - 1; i >= 0; i--) {
		const padW =
			g.paddings[nodes[i] * PAD_STRIDE + PAD_LEFT] +
			g.paddings[nodes[i] * PAD_STRIDE + PAD_RIGHT];
		w += g.widths[nodes[i]] + padW;

		if (g.priorities[nodes[i]] >= priority) {
			return xs[nodes[i]] + w;
		}
	}

	w += g.paddings[nodes[id] * PAD_STRIDE + PAD_LEFT];
	return w;
}

function maxX(
	g: ExpandedGraph,
	nodes: number[],
	id: number,
	xs: Float64Array,
	graphWidth: number,
): number {
	const priority = g.priorities[nodes[id]];
	let w = g.widths[nodes[id]] + g.paddings[nodes[id] * PAD_STRIDE + PAD_RIGHT];

	for (let i = id + 1; i < nodes.length; i++) {
		if (g.priorities[nodes[i]] > priority) {
			return xs[nodes[i]] - w;
		}
		const padW =
			g.paddings[nodes[i] * PAD_STRIDE + PAD_LEFT] +
			g.paddings[nodes[i] * PAD_STRIDE + PAD_RIGHT];
		w += g.widths[nodes[i]] + padW;
	}

	return graphWidth - w;
}

function averagePosition(
	g: ExpandedGraph,
	node: number,
	layerIdx: number,
	isGoingDown: boolean,
	xs: Float64Array,
): number {
	let n = 0;
	let d = 0;

	for (const eidx of g.succEdgeIds[node]) {
		const child = g.edges[eidx].to;
		if (g.layer[child] !== layerIdx) continue;

		const w = g.edges[eidx].weight;
		const wp = g.edges[eidx].waypoints;
		let waypointOffset = wp[1].x - wp[2].x;
		if (isGoingDown) waypointOffset *= -1;

		n += (xs[child] + waypointOffset) * w;
		d += w;
	}

	for (const eidx of g.predEdgeIds[node]) {
		const parent = g.edges[eidx].from;
		if (g.layer[parent] !== layerIdx) continue;

		const w = g.edges[eidx].weight;
		const wp = g.edges[eidx].waypoints;
		let waypointOffset = wp[1].x - wp[2].x;
		if (isGoingDown) waypointOffset *= -1;

		n += (xs[parent] + waypointOffset) * w;
		d += w;
	}

	if (d === 0) return -1;
	return n / d;
}

// ---------- 10b. Straighten long edge chains ----------

function straightenLongEdgeChains(
	g: ExpandedGraph,
	nodeLayers: number[][],
	xs: Float64Array,
	isFlipped?: Uint8Array,
): void {
	if (g.deletedOriginalEdges.size === 0 && g.ioEdgeChains.size === 0) return;

	// Per-layer lists of nodes sorted by xs. Used for gap enumeration below.
	const sortedByX: number[][] = nodeLayers.map((layerNodes) =>
		layerNodes.slice().sort((a, b) => xs[a] - xs[b]),
	);
	const refreshLayer = (layer: number): void => {
		sortedByX[layer].sort((a, b) => xs[a] - xs[b]);
	};

	// Enumerate all gaps in a dummy's layer where the dummy could validly be
	// placed (ignoring priority, so real nodes are hard barriers). Returns
	// ordered [lo, hi] intervals.
	const enumerateGaps = (dummy: number): Array<{ lo: number; hi: number }> => {
		const layer = g.layer[dummy];
		const sorted = sortedByX[layer];
		const selfPadLeft = g.paddings[dummy * PAD_STRIDE + PAD_LEFT];
		const selfPadRight = g.paddings[dummy * PAD_STRIDE + PAD_RIGHT];
		const selfWidth = g.widths[dummy];

		const gaps: Array<{ lo: number; hi: number }> = [];
		let prevRight = Number.NEGATIVE_INFINITY;
		let prevPadRight = 0;

		for (const node of sorted) {
			if (node === dummy) continue;
			const nodeLeft = xs[node];
			const nodeRight = nodeLeft + g.widths[node];
			const nodePadLeft = g.paddings[node * PAD_STRIDE + PAD_LEFT];
			const nodePadRight = g.paddings[node * PAD_STRIDE + PAD_RIGHT];

			const gapLo =
				prevRight === Number.NEGATIVE_INFINITY
					? selfPadLeft
					: prevRight + prevPadRight + selfPadLeft;
			const gapHi = nodeLeft - nodePadLeft - selfPadRight - selfWidth;
			if (gapHi >= gapLo) gaps.push({ lo: gapLo, hi: gapHi });

			prevRight = nodeRight;
			prevPadRight = nodePadRight;
		}

		const tailLo =
			prevRight === Number.NEGATIVE_INFINITY
				? selfPadLeft
				: prevRight + prevPadRight + selfPadLeft;
		gaps.push({ lo: tailLo, hi: Number.MAX_VALUE });

		return gaps;
	};

	// Intersect two sorted interval lists.
	const intersectIntervals = (
		a: Array<{ lo: number; hi: number }>,
		b: Array<{ lo: number; hi: number }>,
	): Array<{ lo: number; hi: number }> => {
		const result: Array<{ lo: number; hi: number }> = [];
		let i = 0;
		let j = 0;
		while (i < a.length && j < b.length) {
			const lo = Math.max(a[i].lo, b[j].lo);
			const hi = Math.min(a[i].hi, b[j].hi);
			if (hi >= lo) result.push({ lo, hi });
			if (a[i].hi < b[j].hi) i++;
			else j++;
		}
		return result;
	};

	type OccupiedRange = { lo: number; hi: number };
	const occupiedColumns = new Map<number, OccupiedRange[]>();
	const COL_BUCKET = 1;

	const isColumnOccupied = (
		x: number,
		layerLo: number,
		layerHi: number,
	): boolean => {
		const key = Math.round(x / COL_BUCKET);
		const ranges = occupiedColumns.get(key);
		if (!ranges) return false;
		for (const r of ranges) {
			if (layerLo < r.hi && r.lo < layerHi) return true;
		}
		return false;
	};

	const registerColumn = (
		x: number,
		layerLo: number,
		layerHi: number,
	): void => {
		const key = Math.round(x / COL_BUCKET);
		let ranges = occupiedColumns.get(key);
		if (!ranges) {
			ranges = [];
			occupiedColumns.set(key, ranges);
		}
		ranges.push({ lo: layerLo, hi: layerHi });
	};

	const processChain = (
		chainEdgeIds: number[],
		isBackEdgeChain: boolean,
	): void => {
		if (chainEdgeIds.length < 2) return;

		const dummySet = new Set<number>();
		const realPortXs: number[] = [];

		for (const edgeId of chainEdgeIds) {
			const edge = g.edges[edgeId];
			const wp = edge.waypoints;
			if (g.isDummy[edge.from]) {
				dummySet.add(edge.from);
			} else {
				realPortXs.push(xs[edge.from] + wp[0].x);
			}
			if (g.isDummy[edge.to]) {
				dummySet.add(edge.to);
			} else {
				realPortXs.push(xs[edge.to] + wp[2].x);
			}
		}

		if (dummySet.size === 0) return;

		const dummies = Array.from(dummySet).sort(
			(a, b) => g.layer[a] - g.layer[b],
		);

		const gapsPerDummy = dummies.map((d) => enumerateGaps(d));

		const sortedDummyXs = dummies.map((d) => xs[d]).sort((a, b) => a - b);
		const median = sortedDummyXs[sortedDummyXs.length >> 1];
		const preferenceOrder = [...realPortXs, median];

		const pickTargetInIntervals = (
			intervals: Array<{ lo: number; hi: number }>,
			layerLo: number,
			layerHi: number,
		): number => {
			const isFree = (x: number): boolean =>
				!isColumnOccupied(x, layerLo, layerHi);

			if (isFlipped) {
				if (isBackEdgeChain) {
					let best = Number.MAX_VALUE;
					for (const iv of intervals) {
						if (iv.lo < best && isFree(iv.lo)) best = iv.lo;
					}
					if (best < Number.MAX_VALUE) return best;
					for (const iv of intervals) {
						if (iv.lo < best) best = iv.lo;
					}
					return best;
				}
				let best = Number.NEGATIVE_INFINITY;
				for (const iv of intervals) {
					if (iv.hi > best && iv.hi < Number.MAX_VALUE && isFree(iv.hi))
						best = iv.hi;
				}
				if (best > Number.NEGATIVE_INFINITY) return best;
				for (const iv of intervals) {
					if (iv.hi > best && iv.hi < Number.MAX_VALUE) best = iv.hi;
				}
				if (best > Number.NEGATIVE_INFINITY) return best;
			}

			for (const pref of preferenceOrder) {
				for (const iv of intervals) {
					if (pref >= iv.lo && pref <= iv.hi && isFree(pref)) return pref;
				}
			}

			const pref = preferenceOrder.length > 0 ? preferenceOrder[0] : 0;
			let best = -1;
			let bestDist = Number.MAX_VALUE;
			for (const iv of intervals) {
				for (const candidate of [
					iv.lo,
					iv.hi < Number.MAX_VALUE ? iv.hi : iv.lo,
				]) {
					if (candidate < iv.lo || candidate > iv.hi) continue;
					if (!isFree(candidate)) continue;
					const d = Math.abs(candidate - pref);
					if (d < bestDist) {
						bestDist = d;
						best = candidate;
					}
				}
			}
			if (best >= 0) return best;

			for (const pref of preferenceOrder) {
				for (const iv of intervals) {
					if (pref >= iv.lo && pref <= iv.hi) return pref;
				}
			}
			best = intervals[0].lo;
			bestDist = Math.abs(best - pref);
			for (const iv of intervals) {
				const candidate = pref < iv.lo ? iv.lo : pref > iv.hi ? iv.hi : pref;
				const d = Math.abs(candidate - pref);
				if (d < bestDist) {
					bestDist = d;
					best = candidate;
				}
			}
			return best;
		};

		const touchedLayers = new Set<number>();
		let runStart = 0;
		let runIntervals = gapsPerDummy[0];

		const flushRun = (runEnd: number): void => {
			if (runIntervals.length === 0) return;
			const layerLo = g.layer[dummies[runStart]];
			const layerHi = g.layer[dummies[runEnd - 1]];
			const target = pickTargetInIntervals(runIntervals, layerLo, layerHi + 1);
			for (let k = runStart; k < runEnd; k++) {
				const dummy = dummies[k];
				if (xs[dummy] !== target) {
					xs[dummy] = target;
					touchedLayers.add(g.layer[dummy]);
				}
			}
			registerColumn(target, layerLo, layerHi + 1);
		};

		for (let i = 1; i < dummies.length; i++) {
			const next = intersectIntervals(runIntervals, gapsPerDummy[i]);
			if (next.length === 0) {
				flushRun(i);
				runStart = i;
				runIntervals = gapsPerDummy[i];
			} else {
				runIntervals = next;
			}
		}
		flushRun(dummies.length);

		for (const layer of touchedLayers) refreshLayer(layer);
	};

	for (const [origEdgeIdx, chainEdgeIds] of g.deletedOriginalEdges) {
		const isBack = isFlipped ? !!isFlipped[origEdgeIdx] : false;
		processChain(chainEdgeIds, isBack);
	}
	for (const [, chainEdgeIds] of g.ioEdgeChains) {
		processChain(chainEdgeIds, false);
	}
}

// ---------- 11. Translate waypoints ----------

function translateWaypoints(g: ExpandedGraph, xs: Float64Array): void {
	for (const edge of g.edges) {
		const wp = edge.waypoints;
		wp[0].x += xs[edge.from];
		wp[1].x += xs[edge.from];
		wp[2].x += xs[edge.to];
		wp[3].x += xs[edge.to];
	}
}

// ---------- 12. Calculate waypoints Y ----------

function calculateWaypointsY(
	g: ExpandedGraph,
	nodeLayers: number[][],
	ys: Float64Array,
): void {
	for (let l = 0; l < g.layerCount; l++) {
		const edgeIndices: number[] = [];
		for (const node of nodeLayers[l]) {
			edgeIndices.push(...g.succEdgeIds[node]);
		}

		if (edgeIndices.length === 0) continue;

		const INT64_MIN = -2147483647;
		const INT64_MAX = 2147483647;
		const layers = new Array<number>(edgeIndices.length).fill(INT64_MIN);
		let maxLayer = INT64_MIN;
		let minLayer = INT64_MAX;

		const getWaypointY = (id: number): number => {
			if (layers[id] !== INT64_MIN) return layers[id];

			layers[id] = INT64_MAX;

			const wp = g.edges[edgeIndices[id]].waypoints;
			const x1 = wp[1].x;
			const x2 = wp[2].x;

			let lmin = INT64_MAX;
			const lmax = INT64_MIN;

			const myStart = Math.min(x1, x2);
			const myEnd = Math.max(x1, x2);

			for (let i = 0; i < edgeIndices.length; i++) {
				if (i === id) continue;

				const owp = g.edges[edgeIndices[i]].waypoints;
				const otherStart = Math.min(owp[1].x, owp[2].x);
				const otherEnd = Math.max(owp[1].x, owp[2].x);

				const rangesOverlap =
					myStart < otherEnd + TOLERANCE && otherStart < myEnd + TOLERANCE;
				if (!rangesOverlap) continue;

				if (otherStart - TOLERANCE <= x2 && x2 <= otherEnd + TOLERANCE) {
					const ol = getWaypointY(i);
					if (ol === INT64_MAX) continue;
					lmin = Math.min(ol - 1, lmin);
				} else {
					const ol = getWaypointY(i);
					if (ol === INT64_MAX) continue;
					lmin = Math.min(ol - 1, lmin);
				}
			}

			let layer = 0;
			if (lmin !== INT64_MAX) {
				layer = lmin;
			} else if (lmax !== INT64_MIN) {
				layer = lmax;
			}

			layers[id] = layer;
			return layer;
		};

		for (let i = 0; i < edgeIndices.length; i++) {
			const lv = getWaypointY(i);
			if (lv > maxLayer) maxLayer = lv;
			if (lv < minLayer) minLayer = lv;
		}

		for (let i = 0; i < edgeIndices.length; i++) {
			const eidx = edgeIndices[i];
			const wp = g.edges[eidx].waypoints;
			const to = g.edges[eidx].to;
			const routingY = ys[to] - Y_GUTTER - (layers[i] - minLayer) * EDGE_HEIGHT;
			wp[1].y = routingY;
			wp[2].y = routingY;
		}
	}

	fixCrossLayerRoutingOverlaps(g, ys);
}

function fixCrossLayerRoutingOverlaps(
	g: ExpandedGraph,
	ys: Float64Array,
): void {
	type Seg = { lo: number; hi: number; coord: number; edgeIdx: number };

	const fixHorizontal = (): boolean => {
		const segs: Seg[] = [];
		for (let i = 0; i < g.edges.length; i++) {
			const wp = g.edges[i].waypoints;
			if (Math.abs(wp[1].y - wp[2].y) > 0.1) continue;
			const lo = Math.min(wp[1].x, wp[2].x);
			const hi = Math.max(wp[1].x, wp[2].x);
			if (hi - lo < 1) continue;
			segs.push({ lo, hi, coord: wp[1].y, edgeIdx: i });
		}
		let changed = false;
		segs.sort((a, b) => a.coord - b.coord || a.lo - b.lo);
		for (let i = 0; i < segs.length; i++) {
			for (let j = i + 1; j < segs.length; j++) {
				if (segs[j].coord - segs[i].coord >= 0.5) break;
				const overlapLen =
					Math.min(segs[i].hi, segs[j].hi) - Math.max(segs[i].lo, segs[j].lo);
				if (overlapLen <= 0.5) continue;
				const wp = g.edges[segs[j].edgeIdx].waypoints;
				wp[1].y -= EDGE_HEIGHT;
				wp[2].y -= EDGE_HEIGHT;
				segs[j].coord -= EDGE_HEIGHT;
				changed = true;
			}
		}
		return changed;
	};

	const wouldCreateHOverlap = (edgeIdx: number, newY: number): boolean => {
		const wp = g.edges[edgeIdx].waypoints;
		const lo = Math.min(wp[1].x, wp[2].x);
		const hi = Math.max(wp[1].x, wp[2].x);
		if (hi - lo < 1) return false;
		for (let k = 0; k < g.edges.length; k++) {
			if (k === edgeIdx) continue;
			const owp = g.edges[k].waypoints;
			if (Math.abs(owp[1].y - owp[2].y) > 0.1) continue;
			if (Math.abs(owp[1].y - newY) >= 0.5) continue;
			const olo = Math.min(owp[1].x, owp[2].x);
			const ohi = Math.max(owp[1].x, owp[2].x);
			if (Math.min(hi, ohi) - Math.max(lo, olo) > 0.5) return true;
		}
		return false;
	};

	const fixVertical = (): boolean => {
		type VInfo = Seg & { isDestSide: boolean };
		const segs: VInfo[] = [];
		for (let i = 0; i < g.edges.length; i++) {
			const wp = g.edges[i].waypoints;
			if (Math.abs(wp[0].x - wp[1].x) < 0.1 && Math.abs(wp[0].y - wp[1].y) > 1)
				segs.push({
					lo: Math.min(wp[0].y, wp[1].y),
					hi: Math.max(wp[0].y, wp[1].y),
					coord: wp[0].x,
					edgeIdx: i,
					isDestSide: false,
				});
			if (Math.abs(wp[2].x - wp[3].x) < 0.1 && Math.abs(wp[2].y - wp[3].y) > 1)
				segs.push({
					lo: Math.min(wp[2].y, wp[3].y),
					hi: Math.max(wp[2].y, wp[3].y),
					coord: wp[2].x,
					edgeIdx: i,
					isDestSide: true,
				});
		}
		let changed = false;
		segs.sort((a, b) => a.coord - b.coord || a.lo - b.lo);
		for (let i = 0; i < segs.length; i++) {
			for (let j = i + 1; j < segs.length; j++) {
				if (Math.abs(segs[j].coord - segs[i].coord) >= 0.5) break;
				if (segs[i].edgeIdx === segs[j].edgeIdx) continue;
				const overlapLen =
					Math.min(segs[i].hi, segs[j].hi) - Math.max(segs[i].lo, segs[j].lo);
				if (overlapLen <= 0.5) continue;

				const bEdge = g.edges[segs[j].edgeIdx];
				const bWp = bEdge.waypoints;
				const srcBottom = ys[bEdge.from] + g.heights[bEdge.from];
				const dstTop = ys[bEdge.to];
				if (dstTop - srcBottom < 2 * EDGE_HEIGHT) continue;

				const targetY = segs[j].isDestSide ? segs[i].hi + 1 : segs[i].lo - 1;
				if (targetY <= srcBottom || targetY >= dstTop) continue;
				if (wouldCreateHOverlap(segs[j].edgeIdx, targetY)) continue;

				bWp[1].y = targetY;
				bWp[2].y = targetY;
				changed = true;
			}
		}
		return changed;
	};

	for (let pass = 0; pass < 8; pass++) {
		const hFixed = fixHorizontal();
		const vFixed = fixVertical();
		if (!hFixed && !vFixed) break;
	}
}

// ---------- 14. Build long edges waypoints ----------

function buildChainWaypoints(
	g: ExpandedGraph,
	chainEdgeIds: number[],
): Point[] {
	const waypoints: Point[] = [];

	for (const eidx of chainEdgeIds) {
		const edge = g.edges[eidx];
		const ws = edge.waypoints;

		if (g.layer[edge.from] < g.layer[edge.to]) {
			waypoints.push(
				{ x: ws[0].x, y: ws[0].y },
				{ x: ws[1].x, y: ws[1].y },
				{ x: ws[2].x, y: ws[2].y },
				{ x: ws[3].x, y: ws[3].y },
			);
		} else {
			waypoints.push(
				{ x: ws[3].x, y: ws[3].y },
				{ x: ws[2].x, y: ws[2].y },
				{ x: ws[1].x, y: ws[1].y },
				{ x: ws[0].x, y: ws[0].y },
			);
		}
	}

	return waypoints;
}

function buildLongEdgesWaypoints(g: ExpandedGraph): void {
	for (const [, chainEdgeIds] of g.deletedOriginalEdges) {
		g.deletedEdgeWaypoints.set(
			chainEdgeIds,
			buildChainWaypoints(g, chainEdgeIds),
		);
	}
}

// ---------- Draw self loops ----------

function drawSelfLoops(
	g: ExpandedGraph,
	selfLoopEdges: number[],
	origEdges: ReadonlyArray<{ src: number; dst: number }>,
	xs: Float64Array,
	ys: Float64Array,
): void {
	for (const edgeIdx of selfLoopEdges) {
		const node = origEdges[edgeIdx].src;

		const width = g.widths[node];
		const height = g.heights[node];

		g.paddings[node * PAD_STRIDE + PAD_RIGHT] -= X_GUTTER;
		g.paddings[node * PAD_STRIDE + PAD_TOP] -= EDGE_HEIGHT;
		g.paddings[node * PAD_STRIDE + PAD_BOTTOM] -= EDGE_HEIGHT;

		const x = xs[node];
		const y = ys[node];

		const parentEdgeCount = g.preds[node].length;
		const childEdgeCount = g.succs[node].length;

		const topX = x + (width / (parentEdgeCount + 1)) * parentEdgeCount;
		const bottomX = x + (width / (childEdgeCount + 1)) * childEdgeCount;

		g.selfLoopWaypoints.set(edgeIdx, [
			{ x: bottomX, y: y + height },
			{ x: bottomX, y: y + height + EDGE_HEIGHT },
			{ x: x + width + X_GUTTER, y: y + height + EDGE_HEIGHT },
			{ x: x + width + X_GUTTER, y: y - EDGE_HEIGHT },
			{ x: topX, y: y - EDGE_HEIGHT },
			{ x: topX, y: y },
		]);
	}
}

// ---------- IO waypoints ----------

function makeIoWaypoints(
	g: ExpandedGraph,
): Map<string, { x: number; y: number }[]> {
	const result = new Map<string, { x: number; y: number }[]>();

	for (const [key, eidx] of g.ioEdges) {
		const edge = g.edges[eidx];
		if (!edge) continue;
		const wp = edge.waypoints;
		result.set(key, [
			{ x: wp[0].x, y: wp[0].y },
			{ x: wp[1].x, y: wp[1].y },
			{ x: wp[2].x, y: wp[2].y },
			{ x: wp[3].x, y: wp[3].y },
		]);
	}

	for (const [key, chainEdgeIds] of g.ioEdgeChains) {
		result.set(key, buildChainWaypoints(g, chainEdgeIds));
	}

	return result;
}

// ---------- Build final polylines ----------

function buildFinalPolylines(
	origEdges: ReadonlyArray<{ src: number; dst: number }>,
	g: ExpandedGraph,
	isFlipped: Uint8Array,
	selfLoopEdges: Set<number>,
): Point[][] {
	const polylines: Point[][] = new Array(origEdges.length);

	for (let e = 0; e < origEdges.length; e++) {
		if (selfLoopEdges.has(e)) {
			const wp = g.selfLoopWaypoints.get(e);
			polylines[e] = wp ? wp.map((p) => ({ x: p.x, y: p.y })) : [];
			continue;
		}

		const flipped = !!isFlipped[e];
		const chain = g.deletedOriginalEdges.get(e);

		if (chain) {
			const wp = g.deletedEdgeWaypoints.get(chain);
			if (wp && wp.length > 0) {
				polylines[e] = wp.map((p) => ({ x: p.x, y: p.y }));
			} else {
				polylines[e] = [];
			}
			continue;
		}

		const eidx = g.originalEdgeToExpanded[e];
		if (eidx !== -1) {
			const wp = g.edges[eidx].waypoints;
			const pts = [
				{ x: wp[0].x, y: wp[0].y },
				{ x: wp[1].x, y: wp[1].y },
				{ x: wp[2].x, y: wp[2].y },
				{ x: wp[3].x, y: wp[3].y },
			];
			if (flipped) pts.reverse();
			polylines[e] = pts;
		} else {
			polylines[e] = [];
		}
	}

	return polylines;
}
