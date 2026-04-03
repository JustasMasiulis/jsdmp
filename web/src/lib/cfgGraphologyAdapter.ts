import Graph from "graphology";
import type { CfgBuildResult } from "./disassemblyGraph";
import type { GraphLayoutCore } from "./graph-layout-core";

type Point = { x: number; y: number };

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
	if (points.length < 2 || trimDistance <= 0) {
		return points;
	}

	let totalLength = 0;
	for (let i = 1; i < points.length; i += 1) {
		const start = points[i - 1];
		const end = points[i];
		totalLength += Math.hypot(end.x - start.x, end.y - start.y);
	}

	if (totalLength <= trimDistance) {
		return points;
	}

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
			if (remaining === 0) {
				return trimmed;
			}
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

export function buildGraphologyGraph(
	_result: CfgBuildResult,
	layout: GraphLayoutCore,
): Graph {
	const graph = new Graph();

	const blockIdByIndex = new Map<number, string>();
	for (const [i, block] of layout.blocks.entries()) {
		blockIdByIndex.set(i, block.data.id);
	}

	for (const block of layout.blocks) {
		const { id, width, height, label } = block.data;
		const { x, y } = block.coordinates;

		graph.addNode(id, {
			x,
			y: -y,
			width,
			height,
			label,
			color: "#f8f9fa",
			borderColor: "#9ca3af",
			type: "rectangle",
			size: Math.max(width, height),
		});
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
			const edgeKey = `${fromId}→${toId}`;

			graph.addEdgeWithKey(edgeKey, fromId, toId, {
				color: cssColor,
				arrowColor: cssColor,
				polylinePoints,
				hidden: true,
			});
		}
	}

	return graph;
}
