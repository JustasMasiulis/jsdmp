import type { CfgBuildResult } from "../lib/disassemblyGraph";
import type { GraphLayoutCore } from "../lib/graph-layout-core";

type Point = { x: number; y: number };

export type CfgRenderNode = {
	id: string;
	x: number;
	y: number;
	width: number;
	height: number;
	borderColor: string;
};

export type CfgRenderEdge = {
	key: string;
	color: string;
	polylinePoints: Array<Point>;
};

export type CfgRenderGraph = {
	nodes: CfgRenderNode[];
	edges: CfgRenderEdge[];
	nodeMap: Map<string, CfgRenderNode>;
	bbox: { x: [number, number]; y: [number, number] };
};

const EDGE_COLOR_CSS: Record<string, string> = {
	red: "#f30c00",
	green: "#009b5e",
	blue: "#3575fe",
	grey: "#B45309",
};

export function trimPolylineEnd(
	points: Array<Point>,
	trimDistance: number,
): Array<Point> {
	if (points.length < 2 || trimDistance <= 0) return points;

	let totalLength = 0;
	for (let i = 1; i < points.length; i += 1) {
		const start = points[i - 1];
		const end = points[i];
		totalLength += Math.hypot(end.x - start.x, end.y - start.y);
	}

	if (totalLength <= trimDistance) return points;

	const trimmed = points.map((point) => ({ ...point }));
	let remaining = trimDistance;

	for (let i = trimmed.length - 1; i > 0; i -= 1) {
		const start = trimmed[i - 1];
		const end = trimmed[i];
		const dx = end.x - start.x;
		const dy = end.y - start.y;
		const length = Math.hypot(dx, dy);

		if (length === 0) {
			trimmed.splice(i, 1);
			continue;
		}

		if (length <= remaining) {
			trimmed.splice(i, 1);
			remaining -= length;
			if (remaining === 0) return trimmed;
			continue;
		}

		const ratio = (length - remaining) / length;
		trimmed[i] = {
			x: start.x + dx * ratio,
			y: start.y + dy * ratio,
		};
		return trimmed;
	}

	return points;
}

export function buildRenderGraph(
	_result: CfgBuildResult,
	layout: GraphLayoutCore,
): CfgRenderGraph {
	const nodes: CfgRenderNode[] = [];
	const edges: CfgRenderEdge[] = [];
	const nodeMap = new Map<string, CfgRenderNode>();

	const blockIdByIndex = new Map<number, string>();
	for (const [i, block] of layout.blocks.entries()) {
		blockIdByIndex.set(i, block.data.id);
	}

	for (const block of layout.blocks) {
		const { id, width, height } = block.data;
		const { x, y } = block.coordinates;

		const node: CfgRenderNode = {
			id,
			x,
			y: -y,
			width,
			height,
			borderColor: "#d1d5db",
		};
		nodes.push(node);
		nodeMap.set(id, node);
	}

	for (const block of layout.blocks) {
		const fromId = block.data.id;
		for (const edge of block.edges) {
			const toId = blockIdByIndex.get(edge.dest);
			if (!toId) continue;

			const polylinePoints: Array<Point> = [];
			for (const segment of edge.path) {
				if (polylinePoints.length === 0) {
					polylinePoints.push({
						x: segment.start.x,
						y: -segment.start.y,
					});
				}
				const lastPoint = polylinePoints[polylinePoints.length - 1];
				const endX = segment.end.x;
				const endY = -segment.end.y;
				if (lastPoint.x !== endX || lastPoint.y !== endY) {
					polylinePoints.push({ x: endX, y: endY });
				}
			}

			const cssColor = EDGE_COLOR_CSS[edge.color] ?? "#B45309";
			edges.push({
				key: `${fromId}\u2192${toId}`,
				color: cssColor,
				polylinePoints,
			});
		}
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

	if (nodes.length === 0) {
		xMin = 0;
		xMax = 0;
		yMin = 0;
		yMax = 0;
	}

	return {
		nodes,
		edges,
		nodeMap,
		bbox: { x: [xMin, xMax], y: [yMin, yMax] },
	};
}
