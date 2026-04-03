import type Graph from "graphology";
import type Sigma from "sigma";
import { renderCfgBlockHtml } from "../lib/cfgHtml";
import type { CfgNode } from "../lib/disassemblyGraph";

const VIEWPORT_CULL_MARGIN = 200;
const CULL_INTERVAL_MS = 150;

type NodeEntry = {
	id: string;
	x: number;
	y: number;
	w: number;
	h: number;
	div: HTMLDivElement;
	attached: boolean;
};

export class CfgBlockOverlay {
	private readonly sigma: Sigma;
	private readonly graph: Graph;
	private readonly container: HTMLDivElement;
	private readonly viewport: HTMLDivElement;
	private readonly blockElements = new Map<string, HTMLDivElement>();
	private readonly termElements = new Map<string, HTMLSpanElement[]>();
	private readonly blockTermSpans = new Map<string, HTMLSpanElement[]>();
	private readonly boundUpdate: () => void;
	private lastCullTime = 0;
	private nodes: NodeEntry[] = [];
	private lastScale = 1;

	constructor(sigma: Sigma, graph: Graph, nodesById: Map<string, CfgNode>) {
		this.sigma = sigma;
		this.graph = graph;

		this.container = document.createElement("div");
		this.container.style.position = "absolute";
		this.container.style.inset = "0";
		this.container.style.pointerEvents = "none";
		this.container.style.overflow = "hidden";

		this.viewport = document.createElement("div");
		this.viewport.style.position = "absolute";
		this.viewport.style.transformOrigin = "0 0";
		this.container.appendChild(this.viewport);

		sigma.getContainer().appendChild(this.container);

		this.prebuildBlocks(nodesById);

		this.boundUpdate = () => this.onFrame();
		sigma.on("afterRender", this.boundUpdate);
		this.syncTransform();
		this.cull();
	}

	getTermElements(): Map<string, HTMLSpanElement[]> {
		return this.termElements;
	}

	getBlockElements(): Map<string, HTMLDivElement> {
		return this.blockElements;
	}

	dispose(): void {
		this.sigma.off("afterRender", this.boundUpdate);
		this.container.remove();
		this.blockElements.clear();
		this.termElements.clear();
		this.blockTermSpans.clear();
		this.nodes = [];
	}

	private prebuildBlocks(nodesById: Map<string, CfgNode>): void {
		this.graph.forEachNode((nodeId) => {
			const graphX = this.graph.getNodeAttribute(nodeId, "x") as number;
			const graphY = -(this.graph.getNodeAttribute(nodeId, "y") as number);
			const w = (this.graph.getNodeAttribute(nodeId, "width") as number) ?? 0;
			const h = (this.graph.getNodeAttribute(nodeId, "height") as number) ?? 0;

			const div = document.createElement("div");
			div.className = "cfg-block";
			div.dataset.blockId = nodeId;
			div.style.position = "absolute";
			div.style.pointerEvents = "auto";
			div.style.left = `${graphX}px`;
			div.style.top = `${graphY}px`;
			div.style.width = `${w}px`;
			div.style.height = `${h}px`;

			const cfgNode = nodesById.get(nodeId);
			if (cfgNode) {
				div.innerHTML = renderCfgBlockHtml(cfgNode);
				this.indexTermSpans(nodeId, div);
			}

			this.blockElements.set(nodeId, div);

			this.nodes.push({
				id: nodeId,
				x: graphX,
				y: graphY,
				w,
				h,
				div,
				attached: false,
			});
		});
	}

	private onFrame(): void {
		this.syncTransform();
		const now = performance.now();
		if (now - this.lastCullTime >= CULL_INTERVAL_MS) {
			this.lastCullTime = now;
			this.cull();
		}
	}

	private syncTransform(): void {
		const bbox = this.sigma.getCustomBBox();
		if (!bbox) return;

		const bboxRange = Math.max(bbox.x[1] - bbox.x[0], bbox.y[1] - bbox.y[0], 1);

		const o0 = this.sigma.graphToViewport({ x: 0, y: 0 });
		const o1 = this.sigma.graphToViewport({ x: bboxRange, y: 0 });
		const scale = (o1.x - o0.x) / bboxRange;
		this.lastScale = scale;

		this.viewport.style.transform = `translate(${o0.x}px, ${o0.y}px) scale(${scale})`;
	}

	private cull(): void {
		const { width: vpW, height: vpH } = this.sigma.getDimensions();
		const scale = this.lastScale;
		if (scale <= 0) return;

		const bbox = this.sigma.getCustomBBox();
		if (!bbox) return;
		const o0 = this.sigma.graphToViewport({ x: 0, y: 0 });

		const margin = VIEWPORT_CULL_MARGIN;
		const invScale = 1 / scale;
		const cullLeft = -o0.x * invScale - margin * invScale;
		const cullTop = -o0.y * invScale - margin * invScale;
		const cullRight = cullLeft + (vpW + margin * 2) * invScale;
		const cullBottom = cullTop + (vpH + margin * 2) * invScale;

		for (const node of this.nodes) {
			const inView =
				node.x + node.w >= cullLeft &&
				node.x <= cullRight &&
				node.y + node.h >= cullTop &&
				node.y <= cullBottom;

			if (inView && !node.attached) {
				this.viewport.appendChild(node.div);
				node.attached = true;
			} else if (!inView && node.attached) {
				node.div.remove();
				node.attached = false;
			}
		}
	}

	private indexTermSpans(nodeId: string, div: HTMLDivElement): void {
		const spans: HTMLSpanElement[] = [];
		for (const span of div.querySelectorAll<HTMLSpanElement>(
			".cfg-block__term",
		)) {
			const term = span.dataset.term;
			if (!term) continue;

			let existing = this.termElements.get(term);
			if (!existing) {
				existing = [];
				this.termElements.set(term, existing);
			}
			existing.push(span);
			spans.push(span);
		}
		this.blockTermSpans.set(nodeId, spans);
	}
}
