import { MutableGraph } from "./graph";
import { computeSESERegions } from "./sese";
import {
	computeCfgAnalysis,
	type IOPair,
	type SugiyamaInput,
	sugiyamaLayout,
	veilConfig,
	Y_GUTTER,
} from "./sugiyama";

export type TriskelInput = SugiyamaInput;

export type TriskelResult = {
	xs: Float64Array;
	ys: Float64Array;
	edgePolylines: Array<Array<{ x: number; y: number }>>;
};

type Point = { x: number; y: number };

type RegionEdge = {
	edge: number;
	src: number;
	dst: number;
};

type RegionData = {
	parent: number;
	children: number[];
	nodes: number[];
	depth: number;
	proxyNode: number;
	rootNode: number;
	subgraphNodes: number[];
	subgraphEdges: RegionEdge[];
	entries: IOPair[];
	exits: IOPair[];
	ioWaypoints: Map<string, Point[]>;
	wasLayout: boolean;
	width: number;
	height: number;
};

type LayoutContext = {
	input: TriskelInput;
	regions: RegionData[];
	xs: Float64Array;
	ys: Float64Array;
	widths: Float64Array;
	heights: Float64Array;
	edgeWaypoints: Point[][];
	startXOffsets: Float64Array;
	endXOffsets: Float64Array;
};

const INVALID = -1;

export function triskelLayout(input: TriskelInput): TriskelResult {
	if (input.nodeCount === 0) {
		return {
			xs: new Float64Array(0),
			ys: new Float64Array(0),
			edgePolylines: [],
		};
	}

	const { regions, regionOf } = buildRegions(input);
	const totalNodeCount = input.nodeCount + regions.length;
	const context: LayoutContext = {
		input,
		regions,
		xs: new Float64Array(totalNodeCount),
		ys: new Float64Array(totalNodeCount),
		widths: new Float64Array(totalNodeCount),
		heights: new Float64Array(totalNodeCount),
		edgeWaypoints: Array.from({ length: input.edges.length }, () => []),
		startXOffsets: new Float64Array(input.edges.length).fill(-1),
		endXOffsets: new Float64Array(input.edges.length).fill(-1),
	};

	for (let node = 0; node < input.nodeCount; node++) {
		context.widths[node] = input.nodeWidths[node];
		context.heights[node] = input.nodeHeights[node];
	}

	initializeSubgraphs(regions, regionOf, input.nodeCount);
	buildRegionEdges(regions, regionOf, input.edges);

	computeRegionLayout(0, context);
	translateRegionTree(0, context);
	tieLooseEnds(context);

	const simplified = context.edgeWaypoints.map(simplifyPolyline);
	return {
		xs: context.xs.slice(0, input.nodeCount) as Float64Array,
		ys: context.ys.slice(0, input.nodeCount) as Float64Array,
		edgePolylines: simplified,
	};
}

function buildRegions(input: TriskelInput): {
	regions: RegionData[];
	regionOf: Int32Array;
} {
	const graph = new MutableGraph(input.nodeCount);
	for (const edge of input.edges) {
		graph.addEdge(edge.src, edge.dst);
	}

	const sese = computeSESERegions(graph, input.root);

	const mutable = sese.regions.map((region) => ({
		parent: region.parent,
		children: region.children.slice(),
		nodes: region.nodes.slice(),
	}));
	const regionOf = Int32Array.from(sese.regionOf, (region) => region);
	const removed = new Uint8Array(mutable.length);
	const smallRegions: number[] = [];

	for (let region = 0; region < mutable.length; region++) {
		if (region === 0) continue;
		if (
			mutable[region].nodes.length === 1 &&
			mutable[region].children.length === 0
		) {
			smallRegions.push(region);
		}
	}

	for (const region of smallRegions) {
		const parent = mutable[region].parent;
		if (parent < 0) continue;

		const node = mutable[region].nodes[0];
		mutable[parent].nodes.push(node);
		regionOf[node] = parent;
		removed[region] = 1;
	}

	for (let region = 0; region < mutable.length; region++) {
		mutable[region].children = mutable[region].children.filter(
			(child) => removed[child] === 0,
		);
	}

	const oldToNew = new Int32Array(mutable.length).fill(INVALID);
	const regions: RegionData[] = [];
	for (let region = 0; region < mutable.length; region++) {
		if (removed[region] !== 0) continue;
		oldToNew[region] = regions.length;
		regions.push({
			parent: INVALID,
			children: [],
			nodes: mutable[region].nodes.slice(),
			depth: 0,
			proxyNode: INVALID,
			rootNode: INVALID,
			subgraphNodes: [],
			subgraphEdges: [],
			entries: [],
			exits: [],
			ioWaypoints: new Map(),
			wasLayout: false,
			width: 0,
			height: 0,
		});
	}

	for (let region = 0; region < mutable.length; region++) {
		if (removed[region] !== 0) continue;
		const newRegion = oldToNew[region];
		regions[newRegion].parent =
			mutable[region].parent < 0 ? INVALID : oldToNew[mutable[region].parent];
		regions[newRegion].children = mutable[region].children.map(
			(child) => oldToNew[child],
		);
	}

	for (let node = 0; node < regionOf.length; node++) {
		regionOf[node] = oldToNew[regionOf[node]];
	}

	const stack = [0];
	while (stack.length > 0) {
		const region = stack.pop()!;
		for (const child of regions[region].children) {
			regions[child].depth = regions[region].depth + 1;
			stack.push(child);
		}
	}

	return { regions, regionOf };
}

function initializeSubgraphs(
	regions: RegionData[],
	regionOf: Int32Array,
	nodeCount: number,
): void {
	for (let region = 0; region < regions.length; region++) {
		regions[region].proxyNode = nodeCount + region;
	}

	for (let node = 0; node < nodeCount; node++) {
		const region = regions[regionOf[node]];
		region.subgraphNodes.push(node);
		if (region.rootNode === INVALID) {
			region.rootNode = node;
		}
	}

	for (let region = 0; region < regions.length; region++) {
		const parent = regions[region].parent;
		if (parent === INVALID) continue;

		regions[parent].subgraphNodes.push(regions[region].proxyNode);
		if (regions[parent].rootNode === INVALID) {
			regions[parent].rootNode = regions[region].proxyNode;
		}
	}
}

function buildRegionEdges(
	regions: RegionData[],
	regionOf: Int32Array,
	edges: ReadonlyArray<{ src: number; dst: number }>,
): void {
	for (let edge = 0; edge < edges.length; edge++) {
		const src = edges[edge].src;
		const dst = edges[edge].dst;
		let fromRegion = regionOf[src];
		let toRegion = regionOf[dst];

		if (fromRegion === toRegion) {
			regions[fromRegion].subgraphEdges.push({ edge, src, dst });
			continue;
		}

		if (isRegionSuccessor(regions, fromRegion, toRegion)) {
			const parentRegion = fromRegion;
			let childRegion = toRegion;
			let nodeId = dst;

			while (childRegion !== parentRegion) {
				regions[childRegion].entries.push({ node: nodeId, edge });
				nodeId = regions[childRegion].proxyNode;
				childRegion = regions[childRegion].parent;
			}

			regions[parentRegion].subgraphEdges.push({ edge, src, dst: nodeId });
			continue;
		}

		if (isRegionSuccessor(regions, toRegion, fromRegion)) {
			const parentRegion = toRegion;
			let childRegion = fromRegion;
			let nodeId = src;

			while (childRegion !== parentRegion) {
				regions[childRegion].exits.push({ node: nodeId, edge });
				nodeId = regions[childRegion].proxyNode;
				childRegion = regions[childRegion].parent;
			}

			regions[parentRegion].subgraphEdges.push({ edge, src: nodeId, dst });
			continue;
		}

		const closestAncestor = getClosestAncestor(regions, fromRegion, toRegion);
		let fromId = src;
		while (fromRegion !== closestAncestor) {
			regions[fromRegion].exits.push({ node: fromId, edge });
			fromId = regions[fromRegion].proxyNode;
			fromRegion = regions[fromRegion].parent;
		}

		let toId = dst;
		while (toRegion !== closestAncestor) {
			regions[toRegion].entries.push({ node: toId, edge });
			toId = regions[toRegion].proxyNode;
			toRegion = regions[toRegion].parent;
		}

		regions[closestAncestor].subgraphEdges.push({
			edge,
			src: fromId,
			dst: toId,
		});
	}
}

function computeRegionLayout(
	regionIndex: number,
	context: LayoutContext,
): void {
	const region = context.regions[regionIndex];
	if (region.wasLayout) {
		return;
	}

	for (const childRegion of region.children) {
		computeRegionLayout(childRegion, context);

		const proxyNode = context.regions[childRegion].proxyNode;
		context.widths[proxyNode] = context.regions[childRegion].width;
		context.heights[proxyNode] = context.regions[childRegion].height;
	}

	const localNodes = region.subgraphNodes.slice();
	const nodeToLocal = new Map<number, number>();
	for (let index = 0; index < localNodes.length; index++) {
		nodeToLocal.set(localNodes[index], index);
	}

	const localWidths = new Float64Array(localNodes.length);
	const localHeights = new Float64Array(localNodes.length);
	for (let index = 0; index < localNodes.length; index++) {
		localWidths[index] = context.widths[localNodes[index]];
		localHeights[index] = context.heights[localNodes[index]];
	}

	const localEdges = region.subgraphEdges.slice();
	const localStartXOffsets = new Float64Array(localEdges.length).fill(-1);
	const localEndXOffsets = new Float64Array(localEdges.length).fill(-1);
	for (let index = 0; index < localEdges.length; index++) {
		localStartXOffsets[index] = context.startXOffsets[localEdges[index].edge];
		localEndXOffsets[index] = context.endXOffsets[localEdges[index].edge];
	}

	const toLocalPairs = (pairs: IOPair[]): IOPair[] =>
		pairs
			.map((pair) => {
				const localNode = nodeToLocal.get(pair.node);
				if (localNode === undefined) {
					return null;
				}
				return { node: localNode, edge: pair.edge };
			})
			.filter((pair): pair is IOPair => pair !== null);

	const localMappedEdges = localEdges.map((edge) => ({
		src: nodeToLocal.get(edge.src)!,
		dst: nodeToLocal.get(edge.dst)!,
	}));
	const localRoot = nodeToLocal.get(region.rootNode) ?? 0;
	const cfgAnalysis = veilConfig.enabled
		? computeCfgAnalysis(localNodes.length, localMappedEdges, localRoot)
		: undefined;

	const result = sugiyamaLayout({
		nodeCount: localNodes.length,
		edges: localMappedEdges,
		nodeWidths: localWidths,
		nodeHeights: localHeights,
		root: localRoot,
		entries: toLocalPairs(region.entries),
		exits: toLocalPairs(region.exits),
		startXOffsets: localStartXOffsets,
		endXOffsets: localEndXOffsets,
		cfgAnalysis,
	});

	for (let index = 0; index < localNodes.length; index++) {
		context.xs[localNodes[index]] = result.xs[index];
		context.ys[localNodes[index]] = result.ys[index];
	}

	for (let index = 0; index < localEdges.length; index++) {
		context.edgeWaypoints[localEdges[index].edge] = clonePoints(
			result.edgePolylines[index],
		);
	}

	region.ioWaypoints.clear();
	const collectIoWaypoints = (pairs: IOPair[]) => {
		for (const pair of pairs) {
			const localNode = nodeToLocal.get(pair.node);
			if (localNode === undefined) continue;

			const waypoints = result.ioWaypoints.get(`${localNode},${pair.edge}`);
			if (!waypoints) continue;

			region.ioWaypoints.set(
				`${pair.node},${pair.edge}`,
				clonePoints(waypoints),
			);
		}
	};

	collectIoWaypoints(region.entries);
	collectIoWaypoints(region.exits);

	for (const entry of region.entries) {
		const waypoints = region.ioWaypoints.get(`${entry.node},${entry.edge}`);
		if (!waypoints || waypoints.length === 0) continue;
		context.endXOffsets[entry.edge] = waypoints[0].x;
	}

	for (const exit of region.exits) {
		const waypoints = region.ioWaypoints.get(`${exit.node},${exit.edge}`);
		if (!waypoints || waypoints.length === 0) continue;
		context.startXOffsets[exit.edge] = waypoints[waypoints.length - 1].x;
	}

	region.width = result.width;
	region.height = result.height;
	context.widths[region.proxyNode] = region.width;
	context.heights[region.proxyNode] = region.height;
	region.wasLayout = true;

	if (result.hasTopLoop) {
		translateRegion(regionIndex, context, { x: 0, y: -2 * Y_GUTTER });
	}
}

function translateRegionTree(
	regionIndex: number,
	context: LayoutContext,
): void {
	const region = context.regions[regionIndex];

	if (region.parent !== INVALID) {
		translateRegion(regionIndex, context, {
			x: context.xs[region.proxyNode],
			y: context.ys[region.proxyNode],
		});
	}

	for (const childRegion of region.children) {
		translateRegionTree(childRegion, context);
	}
}

function translateRegion(
	regionIndex: number,
	context: LayoutContext,
	offset: Point,
): void {
	const region = context.regions[regionIndex];

	for (const node of region.subgraphNodes) {
		context.xs[node] += offset.x;
		context.ys[node] += offset.y;
	}

	for (const edge of region.subgraphEdges) {
		translatePoints(context.edgeWaypoints[edge.edge], offset);
	}

	for (const waypoints of region.ioWaypoints.values()) {
		translatePoints(waypoints, offset);
	}
}

function tieLooseEnds(context: LayoutContext): void {
	for (const region of context.regions) {
		for (const exit of region.exits) {
			const exitWaypoints = region.ioWaypoints.get(`${exit.node},${exit.edge}`);
			const edgeWaypoints = context.edgeWaypoints[exit.edge];
			if (
				!exitWaypoints ||
				exitWaypoints.length === 0 ||
				edgeWaypoints.length === 0
			) {
				continue;
			}

			edgeWaypoints.shift();
			if (edgeWaypoints.length === 0) {
				continue;
			}

			const lastExitWaypoint = exitWaypoints.pop()!;
			edgeWaypoints[0].x = lastExitWaypoint.x;
			edgeWaypoints.unshift(...clonePoints(exitWaypoints));
		}

		for (const entry of region.entries) {
			const entryWaypoints = region.ioWaypoints.get(
				`${entry.node},${entry.edge}`,
			);
			const edgeWaypoints = context.edgeWaypoints[entry.edge];
			if (
				!entryWaypoints ||
				entryWaypoints.length === 0 ||
				edgeWaypoints.length === 0
			) {
				continue;
			}

			edgeWaypoints.pop();
			if (edgeWaypoints.length === 0) {
				continue;
			}

			const firstEntryWaypoint = entryWaypoints.shift()!;
			edgeWaypoints[edgeWaypoints.length - 1].x = firstEntryWaypoint.x;
			edgeWaypoints.push(...clonePoints(entryWaypoints));
		}
	}
}

function isRegionSuccessor(
	regions: RegionData[],
	region: number,
	successor: number,
): boolean {
	if (successor === region) {
		return true;
	}

	if (regions[successor].depth <= regions[region].depth) {
		return false;
	}

	let current = successor;
	while (regions[current].depth > regions[region].depth) {
		current = regions[current].parent;
	}

	return current === region;
}

function getClosestAncestor(
	regions: RegionData[],
	left: number,
	right: number,
): number {
	let leftRegion = left;
	let rightRegion = right;
	const depth = Math.min(regions[leftRegion].depth, regions[rightRegion].depth);

	while (regions[leftRegion].depth !== depth) {
		leftRegion = regions[leftRegion].parent;
	}

	while (regions[rightRegion].depth !== depth) {
		rightRegion = regions[rightRegion].parent;
	}

	while (leftRegion !== rightRegion) {
		leftRegion = regions[leftRegion].parent;
		rightRegion = regions[rightRegion].parent;
	}

	return leftRegion;
}

function translatePoints(points: Point[], offset: Point): void {
	for (const point of points) {
		point.x += offset.x;
		point.y += offset.y;
	}
}

function clonePoints(points: Point[]): Point[] {
	return points.map((point) => ({ x: point.x, y: point.y }));
}

function simplifyPolyline(points: Point[]): Point[] {
	if (points.length <= 2) return clonePoints(points);

	const result: Point[] = [{ x: points[0].x, y: points[0].y }];
	for (let i = 1; i < points.length - 1; i++) {
		const prev = result[result.length - 1];
		const curr = points[i];
		const next = points[i + 1];

		if (curr.x === prev.x && curr.y === prev.y) continue;

		const dx1 = curr.x - prev.x;
		const dy1 = curr.y - prev.y;
		const dx2 = next.x - curr.x;
		const dy2 = next.y - curr.y;
		if (Math.abs(dx1 * dy2 - dy1 * dx2) < 1e-6) continue;

		result.push({ x: curr.x, y: curr.y });
	}

	const last = points[points.length - 1];
	const tail = result[result.length - 1];
	if (last.x !== tail.x || last.y !== tail.y) {
		result.push({ x: last.x, y: last.y });
	}

	return result;
}
