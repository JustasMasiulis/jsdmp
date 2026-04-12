import type {
	CfgRenderEdge,
	CfgRenderGraph,
	CfgRenderNode,
} from "../../rendering/cfgRenderGraph";
import type { CfgBuildResult, CfgEdgeKind } from "../disassemblyGraph";
import { estimateNodeDimensions } from "../disassemblyGraph";
import { triskelLayout } from "./triskel-layout";

const EDGE_COLORS: Record<CfgEdgeKind, string> = {
	true: "#009b5e",
	false: "#f30c00",
	unconditional: "#3575fe",
};

export function triskelBuildRenderGraph(
	result: CfgBuildResult,
): CfgRenderGraph {
	if (result.blocks.length === 0) {
		return {
			nodes: [],
			edges: [],
			nodeMap: new Map(),
			bbox: { x: [0, 0], y: [0, 0] },
		};
	}

	const idToIndex = new Map<string, number>();
	const indexToId: string[] = [];
	for (const block of result.blocks) {
		idToIndex.set(block.id, indexToId.length);
		indexToId.push(block.id);
	}

	const validEdges = result.edges.filter(
		(e) => idToIndex.has(e.from) && idToIndex.has(e.to),
	);
	const layoutEdges = validEdges.map((e) => ({
		src: idToIndex.get(e.from) as number,
		dst: idToIndex.get(e.to) as number,
	}));

	const nodeWidths = new Float64Array(result.blocks.length);
	const nodeHeights = new Float64Array(result.blocks.length);
	for (let i = 0; i < result.blocks.length; i++) {
		const dims = estimateNodeDimensions(result.blocks[i]);
		nodeWidths[i] = dims.width;
		nodeHeights[i] = dims.height;
	}

	const layout = triskelLayout({
		nodeCount: result.blocks.length,
		edges: layoutEdges,
		nodeWidths,
		nodeHeights,
		root: 0,
	});

	const nodes: CfgRenderNode[] = [];
	const nodeMap = new Map<string, CfgRenderNode>();

	for (let i = 0; i < result.blocks.length; i++) {
		const node: CfgRenderNode = {
			id: indexToId[i],
			x: layout.xs[i],
			y: -layout.ys[i],
			width: nodeWidths[i],
			height: nodeHeights[i],
			borderColor: "#d1d5db",
		};
		nodes.push(node);
		nodeMap.set(node.id, node);
	}

	const renderEdges: CfgRenderEdge[] = [];
	for (let i = 0; i < validEdges.length; i++) {
		const e = validEdges[i];
		const fromIdx = idToIndex.get(e.from) as number;
		const toIdx = idToIndex.get(e.to) as number;
		const rawPolyline = layout.edgePolylines[i];

		let polyline: { x: number; y: number }[];
		if (rawPolyline && rawPolyline.length >= 2) {
			polyline = rawPolyline.map((pt) => ({ x: pt.x, y: -pt.y }));
		} else {
			polyline = [
				{
					x: layout.xs[fromIdx] + nodeWidths[fromIdx] / 2,
					y: -(layout.ys[fromIdx] + nodeHeights[fromIdx]),
				},
				{
					x: layout.xs[toIdx] + nodeWidths[toIdx] / 2,
					y: -layout.ys[toIdx],
				},
			];
		}

		renderEdges.push({
			key: `${e.from}\u2192${e.to}`,
			color: EDGE_COLORS[e.kind] ?? "#3575fe",
			polylinePoints: polyline,
		});
	}

	let xMin = Number.POSITIVE_INFINITY;
	let xMax = Number.NEGATIVE_INFINITY;
	let yMin = Number.POSITIVE_INFINITY;
	let yMax = Number.NEGATIVE_INFINITY;

	for (const node of nodes) {
		xMin = Math.min(xMin, node.x);
		xMax = Math.max(xMax, node.x + node.width);
		yMin = Math.min(yMin, node.y - node.height);
		yMax = Math.max(yMax, node.y);
	}

	return {
		nodes,
		edges: renderEdges,
		nodeMap,
		bbox: { x: [xMin, xMax], y: [yMin, yMax] },
	};
}
