import type Graph from "graphology";
import type Sigma from "sigma";
import { renderCfgBlockHtml } from "../lib/cfgHtml";
import type { CfgNode } from "../lib/disassemblyGraph";
import {
	CARD_PADDING_X,
	CARD_PADDING_Y,
	ESTIMATED_CHAR_WIDTH,
	ESTIMATED_LINE_HEIGHT,
} from "../lib/disassemblyGraph";

const FONT_SIZE = 12;
const FONT_FAMILY =
	"ui-monospace, SFMono-Regular, Consolas, 'Liberation Mono', Menlo, monospace";

type NodeEntry = {
	id: string;
	div: HTMLDivElement;
	populated: boolean;
};

export class CfgSelectionLayer {
	private readonly sigma: Sigma;
	private readonly graph: Graph;
	private readonly container: HTMLDivElement;
	private readonly viewport: HTMLDivElement;
	private readonly boundUpdate: () => void;
	private readonly nodesById: Map<string, CfgNode>;
	private readonly letterSpacing: number;
	private readonly paddingTopOffset: number;
	private nodes: NodeEntry[] = [];

	constructor(sigma: Sigma, graph: Graph, nodesById: Map<string, CfgNode>) {
		this.sigma = sigma;
		this.graph = graph;
		this.nodesById = nodesById;

		const measuredCharWidth = CfgSelectionLayer.measureCharWidth();
		this.letterSpacing = ESTIMATED_CHAR_WIDTH - measuredCharWidth;
		const halfLeading = (ESTIMATED_LINE_HEIGHT - FONT_SIZE) / 2;
		this.paddingTopOffset = halfLeading;

		this.container = document.createElement("div");
		this.container.style.position = "absolute";
		this.container.style.inset = "0";
		this.container.style.pointerEvents = "none";
		this.container.style.overflow = "hidden";
		this.container.style.zIndex = "7";

		this.viewport = document.createElement("div");
		this.viewport.style.position = "absolute";
		this.viewport.style.transformOrigin = "0 0";
		this.container.appendChild(this.viewport);

		sigma.getContainer().appendChild(this.container);
		this.prebuildBlocks();

		this.boundUpdate = () => this.syncTransform();
		sigma.on("afterRender", this.boundUpdate);
		this.syncTransform();
	}

	private static measureCharWidth(): number {
		const canvas = document.createElement("canvas");
		const ctx = canvas.getContext("2d")!;
		ctx.font = `${FONT_SIZE}px ${FONT_FAMILY}`;
		return ctx.measureText("M").width;
	}

	dispose(): void {
		this.sigma.off("afterRender", this.boundUpdate);
		this.container.remove();
		this.nodes = [];
	}

	private prebuildBlocks(): void {
		this.graph.forEachNode((nodeId) => {
			const graphX = this.graph.getNodeAttribute(nodeId, "x") as number;
			const graphY = -(this.graph.getNodeAttribute(nodeId, "y") as number);
			const w = (this.graph.getNodeAttribute(nodeId, "width") as number) ?? 0;
			const h = (this.graph.getNodeAttribute(nodeId, "height") as number) ?? 0;

			const cssPadX = CARD_PADDING_X / 2 - 1;
			const cssPadY = CARD_PADDING_Y / 2 - 1 - this.paddingTopOffset;

			const div = document.createElement("div");
			div.className = "cfg-block cfg-block--selection-layer";
			div.style.position = "absolute";
			div.style.left = `${graphX}px`;
			div.style.top = `${graphY}px`;
			div.style.width = `${w}px`;
			div.style.height = `${h}px`;
			div.style.padding = `${cssPadY}px ${cssPadX}px`;
			div.style.color = "transparent";
			div.style.background = "transparent";
			div.style.borderColor = "transparent";
			div.style.letterSpacing = `${this.letterSpacing}px`;
			div.style.pointerEvents = "auto";
			div.style.userSelect = "text";
			div.style.webkitUserSelect = "text";

			this.viewport.appendChild(div);

			const entry: NodeEntry = {
				id: nodeId,
				div,
				populated: false,
			};

			div.addEventListener("mouseenter", () => this.populateBlock(entry));
			div.addEventListener("mouseleave", () => this.depopulateBlock(entry));

			this.nodes.push(entry);
		});
	}

	private populateBlock(entry: NodeEntry): void {
		if (entry.populated) return;
		entry.populated = true;
		const cfgNode = this.nodesById.get(entry.id);
		if (cfgNode) {
			entry.div.innerHTML = renderCfgBlockHtml(cfgNode);
		}
	}

	private depopulateBlock(entry: NodeEntry): void {
		if (!entry.populated) return;
		const sel = window.getSelection();
		if (sel && !sel.isCollapsed && entry.div.contains(sel.anchorNode)) {
			return;
		}
		entry.populated = false;
		entry.div.textContent = "";
	}

	private syncTransform(): void {
		const bbox = this.sigma.getCustomBBox();
		if (!bbox) return;

		const bboxRange = Math.max(bbox.x[1] - bbox.x[0], bbox.y[1] - bbox.y[0], 1);

		const o0 = this.sigma.graphToViewport({ x: 0, y: 0 });
		const o1 = this.sigma.graphToViewport({ x: bboxRange, y: 0 });
		const scale = (o1.x - o0.x) / bboxRange;

		this.viewport.style.transform = `translate(${o0.x}px, ${o0.y}px) scale(${scale})`;
	}
}
