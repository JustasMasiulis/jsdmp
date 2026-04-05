import type { IContentRenderer } from "dockview-core";
import {
	loadAddressPanelState,
	parseHexAddress,
	saveAddressPanelState,
} from "../lib/addressPanelState";
import type { CpuContext } from "../lib/cpu_context";
import { DBG } from "../lib/debugState";
import {
	buildCfg2,
	type CfgBuildResult,
	type CfgEdgeKind,
	type CfgNode,
	estimateNodeDimensions,
} from "../lib/disassemblyGraph";
import { fmtHex16 } from "../lib/formatting";
import {
	type AnnotatedCfgDescriptor,
	type AnnotatedNodeDescriptor,
	type EdgeColor,
	type EdgeDescriptor,
	GraphLayoutCore,
} from "../lib/graph-layout-core";
import type { SignalHandle } from "../lib/reactive";

const DISASSEMBLY_GRAPH_PANEL_STATE_KEY =
	"wasm-dump-debugger:disassembly-graph-panel-state:v1";

const SVG_NS = "http://www.w3.org/2000/svg";

const escapeHtml = (text: string) =>
	text.replace(/[&<>"]/g, (ch) =>
		ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : "&quot;",
	);

const escapeAttr = (text: string) =>
	text.replace(/[&"]/g, (ch) => (ch === "&" ? "&amp;" : "&quot;"));

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 3.0;
const FIT_PADDING = 64;
const EDGE_ARROW_MARKER_WIDTH = 8;
const EDGE_ARROW_MARKER_HEIGHT = 6;
const EDGE_ARROW_REF_X = 0;
const EDGE_ARROW_REF_Y = 3;
const EDGE_ARROW_LINE_TRIM = EDGE_ARROW_MARKER_WIDTH - EDGE_ARROW_REF_X;
const DETAIL_ZOOM_THRESHOLD = 0.2;
const VIEWPORT_MARGIN = 200;

type DisassemblyGraphViewPanelOptions = {
	container: HTMLElement;
	panelId: string;
};

const getPanelStorageKey = (panelId: string) =>
	`${DISASSEMBLY_GRAPH_PANEL_STATE_KEY}:${panelId}`;

const EDGE_COLOR_CSS: Record<EdgeColor, string> = {
	red: "#f30c00",
	green: "#009b5e",
	blue: "#3575fe",
	grey: "#B45309",
};

const cfgEdgeKindToColor = (kind: CfgEdgeKind): EdgeColor => {
	switch (kind) {
		case "true":
			return "green";
		case "false":
			return "red";
		case "unconditional":
			return "blue";
	}
};

const cfgResultToAnnotatedDescriptor = (
	result: CfgBuildResult,
): AnnotatedCfgDescriptor => {
	const nodes: AnnotatedNodeDescriptor[] = result.blocks.map((block) => {
		const dims = estimateNodeDimensions(block);
		return {
			id: block.id,
			label: block.lines.map((line) => line.text).join("\n"),
			width: dims.width,
			height: dims.height,
		};
	});

	const edges: EdgeDescriptor[] = result.edges.map((edge) => ({
		from: edge.from,
		to: edge.to,
		arrows: "to",
		color: cfgEdgeKindToColor(edge.kind),
	}));

	return { nodes, edges };
};

export class VanillaDisassemblyGraphView implements IContentRenderer {
	private readonly panelId: string;
	private readonly contextHandle: SignalHandle<CpuContext | null>;
	private graphResult: CfgBuildResult | null = null;
	private followInstructionPointer = true;
	private manualAddress: bigint | null = null;
	private addressError = "";
	private selectedNodeId: string | null = null;
	private selectedTerm: string | null = null;
	private isLoadingGraph = false;
	private isDisposed = false;
	private reloadToken = 0;

	private readonly root: HTMLElement;
	private readonly addressInput: HTMLInputElement;
	private readonly jumpButton: HTMLButtonElement;
	private readonly followCheckbox: HTMLInputElement;
	private readonly statusNode: HTMLParagraphElement;
	private readonly errorNode: HTMLParagraphElement;
	private readonly emptyNode: HTMLParagraphElement;
	private readonly graphHost: HTMLDivElement;

	private layoutCore: GraphLayoutCore | null = null;
	private viewportElement: HTMLDivElement | null = null;
	private blockContainer: HTMLDivElement | null = null;
	private blockElements = new Map<string, HTMLDivElement>();
	private termElements = new Map<string, HTMLSpanElement[]>();
	private blockTermSpans = new Map<string, HTMLSpanElement[]>();
	private edgeElements: SVGPolylineElement[] = [];
	private edgeOwnership: Array<{ from: string; to: string }> = [];
	private resizeObserver: ResizeObserver | null = null;
	private nodesById = new Map<string, CfgNode>();
	private lastShowDetail = false;

	private hostWidth = 0;
	private hostHeight = 0;
	private panX = 0;
	private panY = 0;
	private zoom = 1;
	private isDragging = false;
	private dragStartX = 0;
	private dragStartY = 0;
	private dragStartPanX = 0;
	private dragStartPanY = 0;

	private readonly onFollowChange = () => {
		const next = this.followCheckbox.checked;
		this.followInstructionPointer = next;
		if (!next && this.manualAddress === null) {
			const ip = DBG.currentContext.state?.ip ?? null;
			if (ip !== null) {
				this.manualAddress = ip;
			}
		}
		this.selectedNodeId = null;
		this.selectedTerm = null;
		this.clearAddressError();
		this.saveState();
		this.refreshView(true);
	};

	private readonly onAddressSubmit = (event: Event) => {
		event.preventDefault();
		void this.submitAddress();
	};

	private readonly onGraphHostClick = (event: MouseEvent) => {
		if (this.isDragging) return;

		const target = this.elementFromEventTarget(event.target);
		const termSpan = target?.closest<HTMLSpanElement>("[data-term]") ?? null;
		const blockDiv = target?.closest<HTMLDivElement>("[data-block-id]") ?? null;
		const blockId = blockDiv?.dataset.blockId ?? null;
		const nextSelectedNodeId = blockId;
		const nextSelectedTerm =
			termSpan?.dataset.term ?? (blockId ? this.selectedTerm : null);

		const needsUpdate =
			this.selectedNodeId !== nextSelectedNodeId ||
			this.selectedTerm !== nextSelectedTerm;
		this.selectedNodeId = nextSelectedNodeId;
		this.selectedTerm = nextSelectedTerm;

		if (needsUpdate) {
			this.syncStatus();
			this.updateSelectionStyles();
		}
	};

	private readonly onGraphHostDoubleClick = (event: MouseEvent) => {
		const target = this.elementFromEventTarget(event.target);
		const termSpan = target?.closest<HTMLSpanElement>("[data-term]") ?? null;
		const lineDiv = target?.closest<HTMLDivElement>(".cfg-block__line") ?? null;
		const blockDiv = target?.closest<HTMLDivElement>("[data-block-id]") ?? null;
		const selectionTarget = termSpan ?? lineDiv ?? blockDiv;
		if (!selectionTarget) {
			return;
		}

		event.preventDefault();
		this.selectElementText(selectionTarget);
	};

	private readonly onPointerDown = (event: PointerEvent) => {
		if (event.button !== 0) return;
		const target = this.elementFromEventTarget(event.target);
		if (target?.closest("[data-block-id]")) return;

		this.isDragging = false;
		this.dragStartX = event.clientX;
		this.dragStartY = event.clientY;
		this.dragStartPanX = this.panX;
		this.dragStartPanY = this.panY;
		this.graphHost.setPointerCapture(event.pointerId);
		this.graphHost.addEventListener("pointermove", this.onPointerMove);
		this.graphHost.addEventListener("pointerup", this.onPointerUp);
	};

	private readonly onPointerMove = (event: PointerEvent) => {
		const dx = event.clientX - this.dragStartX;
		const dy = event.clientY - this.dragStartY;
		if (!this.isDragging && Math.hypot(dx, dy) > 3) {
			this.isDragging = true;
			this.graphHost.classList.add(
				"disassembly-graph-view-panel__graph--panning",
			);
		}
		if (this.isDragging) {
			this.panX = this.dragStartPanX + dx;
			this.panY = this.dragStartPanY + dy;
			this.applyViewportTransform();
		}
	};

	private readonly onPointerUp = (event: PointerEvent) => {
		this.graphHost.releasePointerCapture(event.pointerId);
		this.graphHost.removeEventListener("pointermove", this.onPointerMove);
		this.graphHost.removeEventListener("pointerup", this.onPointerUp);
		this.graphHost.classList.remove(
			"disassembly-graph-view-panel__graph--panning",
		);
		// isDragging is cleared after the click handler fires
		requestAnimationFrame(() => {
			this.isDragging = false;
		});
	};

	private readonly onWheel = (event: WheelEvent) => {
		event.preventDefault();
		const bounds = this.graphHost.getBoundingClientRect();
		const cursorX = event.clientX - bounds.left;
		const cursorY = event.clientY - bounds.top;

		const oldZoom = this.zoom;
		const direction = event.deltaY > 0 ? -1 : 1;
		const newZoom = Math.min(
			MAX_ZOOM,
			Math.max(MIN_ZOOM, oldZoom * 1.15 ** direction),
		);

		// Zoom toward cursor: keep the point under the cursor fixed
		this.panX = cursorX - (cursorX - this.panX) * (newZoom / oldZoom);
		this.panY = cursorY - (cursorY - this.panY) * (newZoom / oldZoom);
		this.zoom = newZoom;
		this.applyViewportTransform();
	};

	constructor(options: DisassemblyGraphViewPanelOptions) {
		this.panelId = options.panelId;
		this.root = this.createRoot(options.panelId);
		const dom = this.createDomTree();
		this.addressInput = dom.addressInput;
		this.jumpButton = dom.jumpButton;
		this.followCheckbox = dom.followCheckbox;
		this.statusNode = dom.statusNode;
		this.errorNode = dom.errorNode;
		this.emptyNode = dom.emptyNode;
		this.graphHost = dom.graphHost;
		options.container.replaceChildren(this.root);

		this.root.addEventListener("submit", this.onAddressSubmit);
		this.followCheckbox.addEventListener("change", this.onFollowChange);
		this.graphHost.addEventListener("click", this.onGraphHostClick);
		this.graphHost.addEventListener("dblclick", this.onGraphHostDoubleClick);
		this.graphHost.addEventListener("pointerdown", this.onPointerDown);
		this.graphHost.addEventListener("wheel", this.onWheel, {
			passive: false,
		});
		if (typeof ResizeObserver !== "undefined") {
			this.resizeObserver = new ResizeObserver((entries) => {
				for (const entry of entries) {
					this.hostWidth = entry.contentRect.width;
					this.hostHeight = entry.contentRect.height;
				}
				this.fitToView();
			});
			this.resizeObserver.observe(this.graphHost);
		}

		this.contextHandle = DBG.currentContext.subscribe(() =>
			this.onContextChanged(),
		);

		this.restoreState();
		this.refreshView(true);
	}

	private onContextChanged() {
		if (this.isDisposed) {
			return;
		}

		this.graphResult = null;
		this.selectedNodeId = null;
		this.selectedTerm = null;
		this.clearAddressError();
		this.refreshView(true);
	}

	get element() {
		return this.root;
	}

	init() {}

	dispose() {
		if (this.isDisposed) {
			return;
		}

		this.isDisposed = true;
		this.contextHandle.dispose();
		this.root.removeEventListener("submit", this.onAddressSubmit);
		this.followCheckbox.removeEventListener("change", this.onFollowChange);
		this.graphHost.removeEventListener("click", this.onGraphHostClick);
		this.graphHost.removeEventListener("dblclick", this.onGraphHostDoubleClick);
		this.graphHost.removeEventListener("pointerdown", this.onPointerDown);
		this.graphHost.removeEventListener("wheel", this.onWheel);
		this.resizeObserver?.disconnect();
		this.resizeObserver = null;
		this.disposeGraph();
		this.root.replaceChildren();
	}

	private createRoot(panelId: string) {
		const root = document.createElement("section");
		root.className = "memory-view-panel disassembly-graph-view-panel";
		root.setAttribute("aria-label", `Disassembly graph view ${panelId}`);
		return root;
	}

	private createDomTree() {
		const toolbar = document.createElement("div");
		toolbar.className = "memory-view-panel__toolbar";

		const jumpForm = document.createElement("form");
		jumpForm.className = "memory-view-panel__jump";

		const jumpLabel = document.createElement("label");
		jumpLabel.className = "memory-view-panel__label";
		jumpLabel.htmlFor = `disassembly-graph-jump-${this.panelId}`;
		jumpLabel.textContent = "Address";

		const addressInput = document.createElement("input");
		addressInput.id = `disassembly-graph-jump-${this.panelId}`;
		addressInput.className = "memory-view-panel__input";
		addressInput.type = "text";
		addressInput.placeholder = "0x0000000000000000";

		const jumpButton = document.createElement("button");
		jumpButton.type = "submit";
		jumpButton.className = "memory-view-panel__button";
		jumpButton.textContent = "Jump";

		jumpForm.append(jumpLabel, addressInput, jumpButton);

		const followLabel = document.createElement("label");
		followLabel.className = "memory-view-panel__toggle";
		const followCheckbox = document.createElement("input");
		followCheckbox.type = "checkbox";
		const followText = document.createElement("span");
		followText.textContent = "Follow IP";
		followLabel.append(followCheckbox, followText);

		toolbar.append(jumpForm, followLabel);

		const statusNode = document.createElement("p");
		statusNode.className = "disassembly-graph-view-panel__status";

		const errorNode = document.createElement("p");
		errorNode.className = "memory-view-panel__error";
		errorNode.hidden = true;

		const emptyNode = document.createElement("p");
		emptyNode.className = "memory-view-panel__empty";
		emptyNode.hidden = true;

		const graphHost = document.createElement("div");
		graphHost.className = "disassembly-graph-view-panel__graph";
		graphHost.hidden = true;

		this.root.append(toolbar, statusNode, errorNode, emptyNode, graphHost);
		return {
			addressInput,
			jumpButton,
			followCheckbox,
			statusNode,
			errorNode,
			emptyNode,
			graphHost,
		};
	}

	private restoreState() {
		const storageKey = getPanelStorageKey(this.panelId);
		const saved = loadAddressPanelState(storageKey);
		if (typeof saved.followInstructionPointer === "boolean") {
			this.followInstructionPointer = saved.followInstructionPointer;
		}

		if (saved.manualAddressHex) {
			const parsed = parseHexAddress(saved.manualAddressHex);
			if (parsed !== null) {
				this.manualAddress = parsed;
			}
		}
	}

	private saveState() {
		const storageKey = getPanelStorageKey(this.panelId);
		saveAddressPanelState(storageKey, {
			manualAddressHex:
				this.manualAddress !== null ? `0x${fmtHex16(this.manualAddress)}` : "",
			followInstructionPointer: this.followInstructionPointer,
		});
	}

	private disposeGraph() {
		this.layoutCore = null;
		this.viewportElement = null;
		this.blockContainer = null;

		this.blockElements.clear();
		this.termElements.clear();
		this.blockTermSpans.clear();
		this.nodesById.clear();
		this.edgeElements = [];
		this.edgeOwnership = [];
		this.prevSelectedNodeId = null;
		this.prevSelectedTerm = null;
		this.lastShowDetail = false;
		this.graphHost.replaceChildren();
	}

	private elementFromEventTarget(target: EventTarget | null) {
		if (target instanceof Element) {
			return target;
		}
		if (target instanceof Node) {
			return target.parentElement;
		}
		return null;
	}

	private selectElementText(element: Node) {
		const selection = window.getSelection();
		if (!selection) {
			return;
		}

		const range = document.createRange();
		range.selectNodeContents(element);
		selection.removeAllRanges();
		selection.addRange(range);
	}

	private syncInputWithAddress(address: bigint | null) {
		this.addressInput.value = address === null ? "" : `0x${fmtHex16(address)}`;
	}

	private currentAnchor() {
		if (this.followInstructionPointer) {
			return DBG.currentContext.state?.ip ?? null;
		}

		if (this.manualAddress === null) {
			return null;
		}

		return this.manualAddress;
	}

	private refreshView(reloadGraph: boolean) {
		this.syncDisplayedAddress();
		if (reloadGraph) {
			void this.reloadGraph();
			return;
		}
		this.syncStatus();
		this.syncControlState();
	}

	private async reloadGraph() {
		const token = ++this.reloadToken;
		const anchorAddress = this.currentAnchor();
		this.selectedNodeId = null;
		this.selectedTerm = null;
		this.isLoadingGraph = true;
		if (anchorAddress === null) {
			this.graphResult = null;
			this.disposeGraph();
			this.isLoadingGraph = false;
			this.syncStatus();
			this.syncControlState();
			return;
		}

		try {
			const nextGraph = await buildCfg2(DBG, anchorAddress);
			if (this.isDisposed || token !== this.reloadToken) {
				return;
			}
			this.graphResult = nextGraph;
		} catch {
			if (this.isDisposed || token !== this.reloadToken) {
				return;
			}
			this.graphResult = {
				anchorAddress,
				blocks: [],
				edges: [],
				stats: {
					blockCount: 0,
					edgeCount: 0,
					instructionCount: 0,
					truncated: false,
				},
			};
		} finally {
			if (!this.isDisposed && token === this.reloadToken) {
				this.isLoadingGraph = false;
			}
		}

		if (!this.graphResult || this.graphResult.blocks.length === 0) {
			this.disposeGraph();
			this.syncStatus();
			this.syncControlState();
			return;
		}

		const descriptor = cfgResultToAnnotatedDescriptor(this.graphResult);

		this.disposeGraph();
		this.layoutCore = new GraphLayoutCore(descriptor, true, true);

		this.graphHost.hidden = false;
		this.hostWidth = this.graphHost.clientWidth;
		this.hostHeight = this.graphHost.clientHeight;
		this.renderGraph();
		this.syncStatus();
		this.syncControlState();
	}

	private renderGraph() {
		const core = this.layoutCore;
		if (!core || core.blocks.length === 0) return;

		const totalWidth = core.getWidth();
		const totalHeight = core.getHeight();

		const viewport = document.createElement("div");
		viewport.className = "cfg-viewport";
		viewport.style.width = `${totalWidth}px`;
		viewport.style.height = `${totalHeight}px`;
		this.viewportElement = viewport;

		const svg = document.createElementNS(SVG_NS, "svg");
		svg.classList.add("cfg-edges");
		svg.setAttribute("width", String(totalWidth));
		svg.setAttribute("height", String(totalHeight));

		this.addSvgArrowMarkers(svg);
		this.renderEdges(svg, core);

		const blockContainer = document.createElement("div");
		blockContainer.style.position = "absolute";
		blockContainer.style.top = "0";
		blockContainer.style.left = "0";
		blockContainer.style.width = `${totalWidth}px`;
		blockContainer.style.height = `${totalHeight}px`;
		this.blockContainer = blockContainer;
		this.nodesById = new Map(
			(this.graphResult?.blocks ?? []).map((node) => [node.id, node]),
		);

		viewport.append(svg, blockContainer);
		this.fitToView();
		this.graphHost.append(viewport);
	}

	private addSvgArrowMarkers(svg: SVGSVGElement) {
		const defs = document.createElementNS(SVG_NS, "defs");
		for (const [name, color] of Object.entries(EDGE_COLOR_CSS)) {
			const marker = document.createElementNS(SVG_NS, "marker");
			marker.setAttribute("id", `arrow-${name}`);
			marker.setAttribute("markerWidth", String(EDGE_ARROW_MARKER_WIDTH));
			marker.setAttribute("markerHeight", String(EDGE_ARROW_MARKER_HEIGHT));
			marker.setAttribute("refX", String(EDGE_ARROW_REF_X));
			marker.setAttribute("refY", String(EDGE_ARROW_REF_Y));
			marker.setAttribute("orient", "auto");
			marker.setAttribute("markerUnits", "userSpaceOnUse");
			const path = document.createElementNS(SVG_NS, "path");
			path.setAttribute(
				"d",
				`M0,0 L${EDGE_ARROW_MARKER_WIDTH},${EDGE_ARROW_REF_Y} L0,${EDGE_ARROW_MARKER_HEIGHT} Z`,
			);
			path.setAttribute("fill", color);
			marker.append(path);
			defs.append(marker);
		}

		svg.append(defs);
	}

	private trimPolylineEnd(
		points: Array<{ x: number; y: number }>,
		trimDistance: number,
	) {
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

	private renderEdges(svg: SVGSVGElement, core: GraphLayoutCore) {
		this.edgeElements = [];
		this.edgeOwnership = [];

		const blockIdByIndex = new Map<number, string>();
		for (const [i, block] of core.blocks.entries()) {
			blockIdByIndex.set(i, block.data.id);
		}

		for (const block of core.blocks) {
			const fromId = block.data.id;
			for (const edge of block.edges) {
				const toId = blockIdByIndex.get(edge.dest);
				if (!toId) continue;

				const rawPoints: Array<{ x: number; y: number }> = [];
				for (const segment of edge.path) {
					if (rawPoints.length === 0) {
						rawPoints.push({ x: segment.start.x, y: segment.start.y });
					}
					const lastPoint = rawPoints[rawPoints.length - 1];
					if (lastPoint.x !== segment.end.x || lastPoint.y !== segment.end.y) {
						rawPoints.push({ x: segment.end.x, y: segment.end.y });
					}
				}
				const points = this.trimPolylineEnd(rawPoints, EDGE_ARROW_LINE_TRIM);

				const polyline = document.createElementNS(SVG_NS, "polyline");
				polyline.classList.add("cfg-edge");
				polyline.setAttribute(
					"points",
					points.map((point) => `${point.x},${point.y}`).join(" "),
				);
				const cssColor = EDGE_COLOR_CSS[edge.color];
				polyline.setAttribute("stroke", cssColor);
				polyline.setAttribute("marker-end", `url(#arrow-${edge.color})`);
				svg.append(polyline);
				this.edgeElements.push(polyline);
				this.edgeOwnership.push({ from: fromId, to: toId });
			}
		}
	}

	private updateVisibleBlocks() {
		const core = this.layoutCore;
		const container = this.blockContainer;
		if (!core || !container) return;

		const showDetail = this.zoom >= DETAIL_ZOOM_THRESHOLD;
		const detailChanged = showDetail !== this.lastShowDetail;
		this.lastShowDetail = showDetail;

		const left = (-this.panX - VIEWPORT_MARGIN) / this.zoom;
		const top = (-this.panY - VIEWPORT_MARGIN) / this.zoom;
		const right = (this.hostWidth - this.panX + VIEWPORT_MARGIN) / this.zoom;
		const bottom = (this.hostHeight - this.panY + VIEWPORT_MARGIN) / this.zoom;

		for (const block of core.blocks) {
			const id = block.data.id;
			const bx = block.coordinates.x;
			const by = block.coordinates.y;
			const visible =
				bx + block.data.width > left &&
				bx < right &&
				by + block.data.height > top &&
				by < bottom;

			const existing = this.blockElements.get(id);

			if (visible && !existing) {
				this.createBlockElement(block, container, showDetail);
			} else if (!visible && existing) {
				this.removeBlockElement(id, existing);
			} else if (visible && existing && detailChanged) {
				this.removeBlockElement(id, existing);
				this.createBlockElement(block, container, showDetail);
			}
		}
	}

	private createBlockElement(
		block: GraphLayoutCore["blocks"][number],
		container: HTMLElement,
		showDetail: boolean,
	) {
		const id = block.data.id;
		const div = document.createElement("div");
		div.className = "cfg-block";
		div.dataset.blockId = id;
		div.style.left = `${block.coordinates.x}px`;
		div.style.top = `${block.coordinates.y}px`;
		div.style.width = `${block.data.width}px`;
		div.style.height = `${block.data.height}px`;

		if (showDetail) {
			const cfgNode = this.nodesById.get(id);
			this.renderBlockText(div, cfgNode, block.data.label, id);
		}

		if (id === this.selectedNodeId) {
			div.classList.add("cfg-block--selected");
		}

		container.append(div);
		this.blockElements.set(id, div);
	}

	private removeBlockElement(id: string, div: HTMLDivElement) {
		div.remove();
		this.blockElements.delete(id);
		const spans = this.blockTermSpans.get(id);
		if (spans) {
			for (const span of spans) {
				const term = span.dataset.term;
				if (!term) continue;
				const arr = this.termElements.get(term);
				if (arr) {
					const idx = arr.indexOf(span);
					if (idx !== -1) arr.splice(idx, 1);
					if (arr.length === 0) this.termElements.delete(term);
				}
			}
			this.blockTermSpans.delete(id);
		}
		if (id === this.prevSelectedNodeId) {
			this.prevSelectedNodeId = null;
		}
	}

	private renderBlockText(
		container: HTMLElement,
		node: CfgNode | null | undefined,
		fallbackLabel: string,
		blockId: string,
	) {
		const lines = node?.lines;
		if (!lines || lines.length === 0) {
			container.textContent = fallbackLabel;
			return;
		}

		let hasTerms = false;
		const parts: string[] = [];
		for (const line of lines) {
			if (line.segments.length === 0) {
				parts.push('<div class="cfg-block__line">');
				parts.push(escapeHtml(line.text));
				parts.push("</div>");
				continue;
			}
			parts.push('<div class="cfg-block__line">');
			for (const segment of line.segments) {
				if (!segment.clickable || !segment.term) {
					parts.push(escapeHtml(segment.text));
					continue;
				}
				hasTerms = true;
				parts.push('<span class="cfg-block__term');
				if (segment.syntaxKind !== "plain") {
					parts.push(" cfg-block__term--syntax-");
					parts.push(segment.syntaxKind);
				}
				parts.push('" data-term="');
				parts.push(escapeAttr(segment.term));
				parts.push('">');
				parts.push(escapeHtml(segment.text));
				parts.push("</span>");
			}
			parts.push("</div>");
		}
		container.innerHTML = parts.join("");

		if (hasTerms) {
			const spans: HTMLSpanElement[] = [];
			const selectedTerm = this.selectedTerm;
			for (const span of container.querySelectorAll<HTMLSpanElement>(
				".cfg-block__term",
			)) {
				const term = span.dataset.term;
				if (!term) continue;
				let existing = this.termElements.get(term);
				if (existing === undefined) {
					existing = [];
					this.termElements.set(term, existing);
				}
				existing.push(span);
				spans.push(span);
				if (term === selectedTerm) {
					span.classList.add("cfg-block__term--selected");
				}
			}
			this.blockTermSpans.set(blockId, spans);
		}
	}

	private applyViewportTransform() {
		if (!this.viewportElement) return;
		this.viewportElement.style.transform = `translate(${this.panX}px, ${this.panY}px) scale(${this.zoom})`;
		this.updateVisibleBlocks();
	}

	private fitToView() {
		const core = this.layoutCore;
		if (!core || core.blocks.length === 0) return;

		const hostWidth = this.hostWidth;
		const hostHeight = this.hostHeight;
		if (hostWidth <= 0 || hostHeight <= 0) return;

		const layoutWidth = core.getWidth();
		const layoutHeight = core.getHeight();

		const scaleX = (hostWidth - FIT_PADDING * 2) / layoutWidth;
		const scaleY = (hostHeight - FIT_PADDING * 2) / layoutHeight;
		this.zoom = Math.max(MIN_ZOOM, Math.min(scaleX, scaleY, 1.0));
		this.panX = (hostWidth - layoutWidth * this.zoom) / 2;
		this.panY = (hostHeight - layoutHeight * this.zoom) / 2;
		this.applyViewportTransform();
	}

	private prevSelectedNodeId: string | null = null;
	private prevSelectedTerm: string | null = null;

	private updateSelectionStyles() {
		const selectedNodeId = this.selectedNodeId;
		const selectedTerm = this.selectedTerm;

		if (this.prevSelectedNodeId !== selectedNodeId) {
			if (this.prevSelectedNodeId !== null) {
				this.blockElements
					.get(this.prevSelectedNodeId)
					?.classList.remove("cfg-block--selected");
			}
			if (selectedNodeId !== null) {
				this.blockElements
					.get(selectedNodeId)
					?.classList.add("cfg-block--selected");
			}
			this.prevSelectedNodeId = selectedNodeId;
		}

		if (this.prevSelectedTerm !== selectedTerm) {
			if (this.prevSelectedTerm !== null) {
				const prevSpans = this.termElements.get(this.prevSelectedTerm);
				if (prevSpans) {
					for (const span of prevSpans) {
						span.classList.remove("cfg-block__term--selected");
					}
				}
			}
			if (selectedTerm !== null) {
				const nextSpans = this.termElements.get(selectedTerm);
				if (nextSpans) {
					for (const span of nextSpans) {
						span.classList.add("cfg-block__term--selected");
					}
				}
			}
			this.prevSelectedTerm = selectedTerm;
		}
	}

	private syncDisplayedAddress() {
		const address = this.currentAnchor();
		if (address !== null) {
			this.syncInputWithAddress(address);
			return;
		}

		if (!this.followInstructionPointer && this.manualAddress !== null) {
			this.syncInputWithAddress(this.manualAddress);
			return;
		}

		this.syncInputWithAddress(null);
	}

	private syncStatus() {
		const result = this.graphResult;
		if (!result) {
			this.statusNode.textContent = this.isLoadingGraph
				? "Loading graph..."
				: "Graph view is idle.";

			return;
		}

		const summary = `${result.stats.blockCount} blocks, ${result.stats.edgeCount} edges, ${result.stats.instructionCount} instr`;
		const selected = this.selectedBlock();
		const selectedText = selected
			? ` Selected ${selected.title} (${selected.instructionCount} instr).`
			: "";
		const termText = this.selectedTerm
			? ` Highlighting "${this.selectedTerm}" (${this.termMatchCount()} matches).`
			: "";
		this.statusNode.textContent = `${summary}.${selectedText}${termText}`;
	}

	private selectedBlock(): CfgNode | null {
		if (!this.graphResult || !this.selectedNodeId) {
			return null;
		}

		return (
			this.graphResult.blocks.find(
				(block) => block.id === this.selectedNodeId,
			) ?? null
		);
	}

	private termMatchCount() {
		if (!this.selectedTerm) {
			return 0;
		}

		return this.termElements.get(this.selectedTerm)?.length ?? 0;
	}

	private syncControlState() {
		const hasGraph = (this.graphResult?.blocks.length ?? 0) > 0;
		this.followCheckbox.checked = this.followInstructionPointer;
		this.addressInput.disabled = this.followInstructionPointer;
		this.jumpButton.disabled = this.followInstructionPointer;
		this.errorNode.hidden = this.addressError.length === 0;
		this.errorNode.textContent = this.addressError;
		this.emptyNode.hidden = hasGraph;
		this.graphHost.hidden = !hasGraph;
		if (!hasGraph) {
			this.emptyNode.textContent = this.emptyMessage();
		}
	}

	private emptyMessage() {
		if (this.addressError) {
			return "No graph instructions available.";
		}
		if (this.graphResult) {
			return "No graph instructions available.";
		}
		if (this.isLoadingGraph) {
			return "Loading graph...";
		}
		if (!this.followInstructionPointer && this.manualAddress !== null) {
			return "Enter an address that exists in dump memory to view a graph.";
		}
		if (this.followInstructionPointer && DBG.currentContext.state?.ip == null) {
			return "No instruction pointer available.";
		}
		return "Disassembly graph view is unavailable for this dump.";
	}

	private setAddressError(message: string) {
		this.addressError = message;
		this.syncControlState();
	}

	private clearAddressError() {
		if (!this.addressError) {
			return;
		}

		this.addressError = "";
		this.syncControlState();
	}

	private async submitAddress() {
		const parsed = parseHexAddress(this.addressInput.value);
		if (parsed === null) {
			this.setAddressError(
				"Address must be hexadecimal (for example: 0x7FF612340000).",
			);
			return;
		}

		this.manualAddress = parsed;
		this.followInstructionPointer = false;
		this.selectedNodeId = null;
		this.selectedTerm = null;
		this.clearAddressError();
		this.saveState();
		this.refreshView(true);
	}
}
