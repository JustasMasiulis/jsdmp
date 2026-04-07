import type { CfgNode, CfgTextSegment } from "../lib/disassemblyGraph";
import {
	CARD_PADDING_X,
	CARD_PADDING_Y,
	ESTIMATED_CHAR_WIDTH,
	ESTIMATED_LINE_HEIGHT,
	getCfgLineAddress,
} from "../lib/disassemblyGraph";
import type { BlockTextRenderer } from "./blockTextProgram";
import type { CfgGraphRenderer } from "./cfgGraphRenderer";
import type { CfgRenderGraph } from "./cfgRenderGraph";

const SELECTED_BORDER_COLOR = "#3575fe";
const DEFAULT_BORDER_COLOR = "#d1d5db";

type NodePos = {
	id: string;
	x: number;
	y: number;
	w: number;
	h: number;
};

export class CfgInteractionHandler {
	private readonly renderer: CfgGraphRenderer;
	private readonly graph: CfgRenderGraph;
	private readonly textRenderer: BlockTextRenderer;
	private readonly nodesById: Map<string, CfgNode>;
	private readonly statusCallback: (status: string) => void;
	private readonly addressCallback: ((address: bigint) => void) | null;
	private readonly nodePositions: NodePos[] = [];
	private readonly termCounts: Map<string, number>;

	private _selectedNodeId: string | null = null;
	private _selectedTerm: string | null = null;

	private readonly boundOnClick: (event: MouseEvent) => void;

	constructor(
		renderer: CfgGraphRenderer,
		graph: CfgRenderGraph,
		textRenderer: BlockTextRenderer,
		nodesById: Map<string, CfgNode>,
		statusCallback: (status: string) => void,
		addressCallback?: (address: bigint) => void,
	) {
		this.renderer = renderer;
		this.graph = graph;
		this.textRenderer = textRenderer;
		this.nodesById = nodesById;
		this.statusCallback = statusCallback;
		this.addressCallback = addressCallback ?? null;

		this.termCounts = this.buildTermCounts();

		for (const node of graph.nodes) {
			this.nodePositions.push({
				id: node.id,
				x: node.x,
				y: -node.y,
				w: node.width,
				h: node.height,
			});
		}

		this.boundOnClick = (e) => this.handleClick(e);
		const container = renderer.getContainer();
		container.addEventListener("click", this.boundOnClick);
	}

	get selectedNodeId(): string | null {
		return this._selectedNodeId;
	}

	get selectedTerm(): string | null {
		return this._selectedTerm;
	}

	fitToView(): void {
		const { width, height } = this.renderer.getDimensions();
		if (width <= 0 || height <= 0) return;

		const bbox = this.renderer.getBBox();
		const bboxW = bbox.x[1] - bbox.x[0];
		const bboxH = bbox.y[1] - bbox.y[0];
		const bboxRange = Math.max(bboxW, bboxH, 1);

		const padding = 64;
		const normW = bboxW / bboxRange;
		const normH = bboxH / bboxRange;
		const ratioX = (normW * width) / Math.max(width - padding * 2, 1);
		const ratioY = (normH * height) / Math.max(height - padding * 2, 1);

		this.renderer.setCameraState({
			x: 0.5,
			y: 0.5,
			ratio: Math.max(ratioX, ratioY, 0.1),
		});
	}

	focusLine(nodeId: string, lineIndex: number): void {
		this.applyNodeSelection(nodeId);

		const renderNode = this.graph.nodeMap.get(nodeId);
		if (!renderNode) return;

		const bbox = this.renderer.getBBox();
		const bboxRange = Math.max(bbox.x[1] - bbox.x[0], bbox.y[1] - bbox.y[0], 1);
		const bboxCenterX = (bbox.x[0] + bbox.x[1]) / 2;
		const bboxCenterY = (bbox.y[0] + bbox.y[1]) / 2;

		const centerX = renderNode.x + renderNode.width / 2;
		const lineY =
			renderNode.y -
			CARD_PADDING_Y / 2 -
			lineIndex * ESTIMATED_LINE_HEIGHT -
			ESTIMATED_LINE_HEIGHT / 2;

		this.renderer.setCameraState({
			x: 0.5 + (centerX - bboxCenterX) / bboxRange,
			y: 0.5 + (lineY - bboxCenterY) / bboxRange,
			ratio: this.renderer.getCameraRatio(),
		});

		this.textRenderer.markDirtyAndRender();
	}

	dispose(): void {
		const container = this.renderer.getContainer();
		container.removeEventListener("click", this.boundOnClick);
	}

	private handleClick(event: MouseEvent): void {
		const sel = window.getSelection();
		if (sel && !sel.isCollapsed) return;

		const rect = this.renderer.getContainer().getBoundingClientRect();
		const vx = event.clientX - rect.left;
		const vy = event.clientY - rect.top;

		const graphPos = this.renderer.viewportToGraph({ x: vx, y: vy });
		const gx = graphPos.x;
		const gy = -graphPos.y;

		const block = this.findBlockAtPoint(gx, gy);
		if (!block) {
			this.selectNode(null);
			this.selectTerm(null);
			this.textRenderer.highlightLineAddress(null);
			return;
		}

		this.selectNode(block.id);

		const seg = this.findSegmentAtPoint(block, gx, gy);
		this.selectTerm(seg?.term ?? null);

		if (this.addressCallback) {
			const address = this.findClickedLineAddress(block, gy);
			if (address !== null) this.addressCallback(address);
		}
	}

	private findBlockAtPoint(gx: number, gy: number): NodePos | null {
		for (const node of this.nodePositions) {
			if (
				gx >= node.x &&
				gx <= node.x + node.w &&
				gy >= node.y &&
				gy <= node.y + node.h
			) {
				return node;
			}
		}
		return null;
	}

	private findSegmentAtPoint(
		block: NodePos,
		gx: number,
		gy: number,
	): CfgTextSegment | null {
		const cfgNode = this.nodesById.get(block.id);
		if (!cfgNode) return null;

		const localX = gx - block.x - CARD_PADDING_X / 2;
		const localY = gy - block.y - CARD_PADDING_Y / 2;

		const lineIdx = Math.floor(localY / ESTIMATED_LINE_HEIGHT);
		if (lineIdx < 0 || lineIdx >= cfgNode.lines.length) return null;

		const charIdx = Math.floor(localX / ESTIMATED_CHAR_WIDTH);
		if (charIdx < 0) return null;

		const line = cfgNode.lines[lineIdx];
		let pos = 0;
		for (const seg of line.segments) {
			if (charIdx >= pos && charIdx < pos + seg.text.length) {
				return seg;
			}
			pos += seg.text.length;
		}
		return null;
	}

	private applyNodeSelection(nodeId: string | null): void {
		const prev = this._selectedNodeId;
		if (prev === nodeId) return;

		if (prev !== null) {
			const prevNode = this.graph.nodeMap.get(prev);
			if (prevNode) prevNode.borderColor = DEFAULT_BORDER_COLOR;
		}

		this._selectedNodeId = nodeId;

		if (nodeId !== null) {
			const nextNode = this.graph.nodeMap.get(nodeId);
			if (nextNode) nextNode.borderColor = SELECTED_BORDER_COLOR;
		}

		this.emitStatus();
	}

	private selectNode(nodeId: string | null): void {
		this.applyNodeSelection(nodeId);
		this.textRenderer.markDirtyAndRender();
	}

	private selectTerm(term: string | null): void {
		if (this._selectedTerm === term) return;
		this._selectedTerm = term;
		this.textRenderer.highlightTerm(term);
		this.emitStatus();
	}

	private emitStatus(): void {
		const parts: string[] = [];
		if (this._selectedNodeId) {
			parts.push(`Selected ${this._selectedNodeId}.`);
		}
		if (this._selectedTerm) {
			const count = this.termCounts.get(this._selectedTerm) ?? 0;
			parts.push(`Highlighting "${this._selectedTerm}" (${count} matches).`);
		}
		this.statusCallback(parts.join(" "));
	}

	private findClickedLineAddress(block: NodePos, gy: number): bigint | null {
		const cfgNode = this.nodesById.get(block.id);
		if (!cfgNode) return null;

		const localY = gy - block.y - CARD_PADDING_Y / 2;
		const lineIdx = Math.floor(localY / ESTIMATED_LINE_HEIGHT);
		if (lineIdx < 0 || lineIdx >= cfgNode.lines.length) return null;

		return getCfgLineAddress(cfgNode.lines[lineIdx]);
	}

	private buildTermCounts(): Map<string, number> {
		const counts = new Map<string, number>();
		for (const node of this.nodesById.values()) {
			for (const line of node.lines) {
				for (const seg of line.segments) {
					if (seg.term) {
						counts.set(seg.term, (counts.get(seg.term) ?? 0) + 1);
					}
				}
			}
		}
		return counts;
	}
}
