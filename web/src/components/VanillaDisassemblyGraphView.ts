import {
	formatHexAddress,
	loadAddressPanelState,
	parseHexAddress,
	saveAddressPanelState,
} from "../lib/addressPanelState";
import type { ResolvedDumpContext } from "../lib/context";
import {
	buildControlFlowGraph,
	type CfgBuildResult,
	type CfgEdgeKind,
	type CfgNode,
	estimateNodeDimensions,
} from "../lib/disassemblyGraph";
import type { ParsedDumpInfo } from "../lib/dumpInfo";
import {
	type AnnotatedCfgDescriptor,
	type AnnotatedNodeDescriptor,
	type EdgeColor,
	type EdgeDescriptor,
	GraphLayoutCore,
} from "../lib/graph-layout-core";

const DISASSEMBLY_GRAPH_PANEL_STATE_KEY =
	"wasm-dump-debugger:disassembly-graph-panel-state:v1";

const SVG_NS = "http://www.w3.org/2000/svg";

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 3.0;
const ZOOM_FACTOR = 0.1;
const FIT_PADDING = 64;

type DisassemblyGraphViewPanelOptions = {
	container: HTMLElement;
	dumpInfo: ParsedDumpInfo;
	panelId: string;
};

const getPanelStorageKey = (panelId: string) =>
	`${DISASSEMBLY_GRAPH_PANEL_STATE_KEY}:${panelId}`;

const EDGE_COLOR_CSS: Record<EdgeColor, string> = {
	red: "#BE123C",
	green: "#0F766E",
	blue: "#2563EB",
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
			label: block.label,
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

export class VanillaDisassemblyGraphView {
	private readonly panelId: string;
	private dumpInfo: ParsedDumpInfo;
	private resolvedContext: ResolvedDumpContext | null;
	private graphResult: CfgBuildResult | null = null;
	private followInstructionPointer = true;
	private manualAddress: bigint | null = null;
	private addressError = "";
	private selectedNodeId: string | null = null;
	private isDisposed = false;

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
	private blockElements = new Map<string, HTMLDivElement>();
	private edgeElements: SVGPolylineElement[] = [];
	private edgeOwnership: Array<{ from: string; to: string }> = [];
	private resizeObserver: ResizeObserver | null = null;

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
			const followAddress = this.resolvedContext?.anchorAddress;
			if (followAddress !== null && followAddress !== undefined) {
				this.manualAddress = followAddress;
			}
		}
		this.selectedNodeId = null;
		this.clearAddressError();
		this.saveState();
		this.refreshView(true);
	};

	private readonly onAddressSubmit = (event: Event) => {
		event.preventDefault();
		const parsed = parseHexAddress(this.addressInput.value);
		if (parsed === null) {
			this.setAddressError(
				"Address must be hexadecimal (for example: 0x7FF612340000).",
			);
			return;
		}

		if (!this.dumpInfo.findMemoryRangeAt(parsed)) {
			this.setAddressError(
				"Address is not present in dump memory and cannot be graphed.",
			);
			return;
		}

		this.manualAddress = parsed;
		this.followInstructionPointer = false;
		this.selectedNodeId = null;
		this.clearAddressError();
		this.saveState();
		this.refreshView(true);
	};

	private readonly onGraphHostClick = (event: MouseEvent) => {
		if (this.isDragging) return;

		const target = event.target as HTMLElement;
		const blockDiv = target.closest<HTMLDivElement>("[data-block-id]");
		const blockId = blockDiv?.dataset.blockId ?? null;

		const needsUpdate = this.selectedNodeId !== blockId;
		this.selectedNodeId = blockId;

		if (needsUpdate) {
			this.syncStatus();
			this.updateSelectionStyles();
		}
	};

	private readonly onPointerDown = (event: PointerEvent) => {
		if (event.button !== 0) return;
		const target = event.target as HTMLElement;
		if (target.closest("[data-block-id]")) return;

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
			Math.max(MIN_ZOOM, oldZoom * (1 + direction * ZOOM_FACTOR)),
		);

		// Zoom toward cursor: keep the point under the cursor fixed
		this.panX = cursorX - (cursorX - this.panX) * (newZoom / oldZoom);
		this.panY = cursorY - (cursorY - this.panY) * (newZoom / oldZoom);
		this.zoom = newZoom;
		this.applyViewportTransform();
	};

	constructor(options: DisassemblyGraphViewPanelOptions) {
		this.panelId = options.panelId;
		this.dumpInfo = options.dumpInfo;
		this.resolvedContext = options.dumpInfo.resolvedContext;
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
		this.graphHost.addEventListener("pointerdown", this.onPointerDown);
		this.graphHost.addEventListener("wheel", this.onWheel, {
			passive: false,
		});
		if (typeof ResizeObserver !== "undefined") {
			this.resizeObserver = new ResizeObserver(() => {
				this.fitToView();
			});
			this.resizeObserver.observe(this.graphHost);
		}

		this.restoreState();
		this.refreshView(true);
	}

	update(nextDumpInfo: ParsedDumpInfo) {
		if (this.isDisposed) {
			return;
		}

		const changed = nextDumpInfo !== this.dumpInfo;
		this.dumpInfo = nextDumpInfo;
		this.resolvedContext = nextDumpInfo.resolvedContext;
		if (changed) {
			this.graphResult = null;
			this.selectedNodeId = null;
			this.clearAddressError();
		}
		this.refreshView(true);
	}

	dispose() {
		if (this.isDisposed) {
			return;
		}

		this.isDisposed = true;
		this.root.removeEventListener("submit", this.onAddressSubmit);
		this.followCheckbox.removeEventListener("change", this.onFollowChange);
		this.graphHost.removeEventListener("click", this.onGraphHostClick);
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
				this.manualAddress !== null ? formatHexAddress(this.manualAddress) : "",
			followInstructionPointer: this.followInstructionPointer,
		});
	}

	private disposeGraph() {
		this.layoutCore = null;
		this.viewportElement = null;

		this.blockElements.clear();
		this.edgeElements = [];
		this.edgeOwnership = [];
		this.graphHost.replaceChildren();
	}

	private syncInputWithAddress(address: bigint | null) {
		this.addressInput.value = address === null ? "" : formatHexAddress(address);
	}

	private currentAnchor() {
		if (this.followInstructionPointer) {
			return this.resolvedContext?.anchorAddress ?? null;
		}

		if (this.manualAddress === null) {
			return null;
		}

		return this.dumpInfo.findMemoryRangeAt(this.manualAddress)
			? this.manualAddress
			: null;
	}

	private refreshView(reloadGraph: boolean) {
		this.syncDisplayedAddress();
		if (reloadGraph) {
			this.reloadGraph();
		}
		this.syncStatus();
		this.syncControlState();
	}

	private reloadGraph() {
		const anchorAddress = this.currentAnchor();
		this.selectedNodeId = null;
		if (anchorAddress === null) {
			this.graphResult = null;
			this.disposeGraph();
			return;
		}

		try {
			this.graphResult = buildControlFlowGraph(this.dumpInfo, anchorAddress);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.graphResult = {
				status: "decode_error",
				message: `Graph loading failed: ${message}`,
				anchorAddress,
				anchorNodeId: null,
				blocks: [],
				edges: [],
				stats: {
					blockCount: 0,
					edgeCount: 0,
					instructionCount: 0,
					truncated: false,
				},
			};
		}

		if (!this.graphResult || this.graphResult.blocks.length === 0) {
			this.disposeGraph();
			return;
		}

		const descriptor = cfgResultToAnnotatedDescriptor(this.graphResult);

		this.disposeGraph();
		this.layoutCore = new GraphLayoutCore(descriptor, true, true);
		this.graphHost.hidden = false;
		this.renderGraph();
		this.fitToView();
	}

	private renderGraph() {
		const core = this.layoutCore;
		if (!core || core.blocks.length === 0) return;

		const totalWidth = core.getWidth();
		const totalHeight = core.getHeight();

		// Viewport container
		const viewport = document.createElement("div");
		viewport.className = "cfg-viewport";
		viewport.style.width = `${totalWidth}px`;
		viewport.style.height = `${totalHeight}px`;
		this.viewportElement = viewport;

		// SVG edge layer
		const svg = document.createElementNS(SVG_NS, "svg");
		svg.classList.add("cfg-edges");
		svg.setAttribute("width", String(totalWidth));
		svg.setAttribute("height", String(totalHeight));

		this.addSvgArrowMarkers(svg);
		this.renderEdges(svg, core);

		// Block container (sits on top of SVG)
		const blockContainer = document.createElement("div");
		blockContainer.style.position = "absolute";
		blockContainer.style.top = "0";
		blockContainer.style.left = "0";
		blockContainer.style.width = `${totalWidth}px`;
		blockContainer.style.height = `${totalHeight}px`;
		this.renderBlocks(blockContainer, core);

		viewport.append(svg, blockContainer);
		this.graphHost.append(viewport);
		this.applyViewportTransform();
	}

	private addSvgArrowMarkers(svg: SVGSVGElement) {
		const defs = document.createElementNS(SVG_NS, "defs");
		for (const [name, color] of Object.entries(EDGE_COLOR_CSS)) {
			const marker = document.createElementNS(SVG_NS, "marker");
			marker.setAttribute("id", `arrow-${name}`);
			marker.setAttribute("markerWidth", "8");
			marker.setAttribute("markerHeight", "6");
			marker.setAttribute("refX", "8");
			marker.setAttribute("refY", "3");
			marker.setAttribute("orient", "auto");
			marker.setAttribute("markerUnits", "userSpaceOnUse");
			const path = document.createElementNS(SVG_NS, "path");
			path.setAttribute("d", "M0,0 L8,3 L0,6 Z");
			path.setAttribute("fill", color);
			marker.append(path);
			defs.append(marker);
		}
		// Dimmed arrow marker
		const dimMarker = document.createElementNS(SVG_NS, "marker");
		dimMarker.setAttribute("id", "arrow-dimmed");
		dimMarker.setAttribute("markerWidth", "8");
		dimMarker.setAttribute("markerHeight", "6");
		dimMarker.setAttribute("refX", "8");
		dimMarker.setAttribute("refY", "3");
		dimMarker.setAttribute("orient", "auto");
		dimMarker.setAttribute("markerUnits", "userSpaceOnUse");
		const dimPath = document.createElementNS(SVG_NS, "path");
		dimPath.setAttribute("d", "M0,0 L8,3 L0,6 Z");
		dimPath.setAttribute("fill", "#D0D5DD");
		dimMarker.append(dimPath);
		defs.append(dimMarker);

		svg.append(defs);
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

				const points: string[] = [];
				for (const segment of edge.path) {
					if (points.length === 0) {
						points.push(`${segment.start.x},${segment.start.y}`);
					}
					points.push(`${segment.end.x},${segment.end.y}`);
				}

				const polyline = document.createElementNS(SVG_NS, "polyline");
				polyline.classList.add("cfg-edge");
				polyline.setAttribute("points", points.join(" "));
				const cssColor = EDGE_COLOR_CSS[edge.color];
				polyline.setAttribute("stroke", cssColor);
				polyline.setAttribute("marker-end", `url(#arrow-${edge.color})`);
				svg.append(polyline);
				this.edgeElements.push(polyline);
				this.edgeOwnership.push({ from: fromId, to: toId });
			}
		}
	}

	private renderBlocks(container: HTMLElement, core: GraphLayoutCore) {
		this.blockElements.clear();
		const anchorNodeId = this.graphResult?.anchorNodeId ?? null;

		for (const block of core.blocks) {
			const div = document.createElement("div");
			div.className = "cfg-block";
			div.dataset.blockId = block.data.id;
			div.style.left = `${block.coordinates.x}px`;
			div.style.top = `${block.coordinates.y}px`;
			div.style.width = `${block.data.width}px`;
			div.style.height = `${block.data.height}px`;

			// Find the CfgNode to get the kind
			const cfgNode = this.graphResult?.blocks.find(
				(b) => b.id === block.data.id,
			);
			if (cfgNode && cfgNode.kind !== "block") {
				div.classList.add(`cfg-block--kind-${cfgNode.kind}`);
			}
			if (block.data.id === anchorNodeId) {
				div.classList.add("cfg-block--anchor");
			}

			div.textContent = block.data.label;
			container.append(div);
			this.blockElements.set(block.data.id, div);
		}
	}

	private applyViewportTransform() {
		if (!this.viewportElement) return;
		this.viewportElement.style.transform = `translate(${this.panX}px, ${this.panY}px) scale(${this.zoom})`;
	}

	private fitToView() {
		const core = this.layoutCore;
		if (!core || core.blocks.length === 0) return;

		const hostWidth = this.graphHost.clientWidth;
		const hostHeight = this.graphHost.clientHeight;
		if (hostWidth <= 0 || hostHeight <= 0) return;

		const layoutWidth = core.getWidth();
		const layoutHeight = core.getHeight();

		const scaleX = (hostWidth - FIT_PADDING * 2) / layoutWidth;
		const scaleY = (hostHeight - FIT_PADDING * 2) / layoutHeight;
		this.zoom = Math.min(scaleX, scaleY, 1.0);
		this.panX = (hostWidth - layoutWidth * this.zoom) / 2;
		this.panY = (hostHeight - layoutHeight * this.zoom) / 2;
		this.applyViewportTransform();
	}

	private updateSelectionStyles() {
		const selected = this.selectedNodeId;
		const anchorId = this.graphResult?.anchorNodeId ?? null;

		for (const [id, div] of this.blockElements) {
			const isSelected = id === selected;
			const isAnchor = id === anchorId;
			const isDimmed = selected !== null && !isSelected && !isAnchor;
			div.classList.toggle("cfg-block--selected", isSelected);
			div.classList.toggle("cfg-block--dimmed", isDimmed);
		}

		for (let i = 0; i < this.edgeElements.length; i++) {
			const polyline = this.edgeElements[i];
			const ownership = this.edgeOwnership[i];
			const isDimmed =
				selected !== null &&
				ownership.from !== selected &&
				ownership.to !== selected;
			polyline.classList.toggle("cfg-edge--dimmed", isDimmed);
			if (isDimmed) {
				polyline.setAttribute("marker-end", "url(#arrow-dimmed)");
			} else {
				// Restore original marker from stroke color
				const stroke = polyline.getAttribute("stroke") ?? "";
				const colorName =
					Object.entries(EDGE_COLOR_CSS).find(
						([, css]) => css === stroke,
					)?.[0] ?? "blue";
				polyline.setAttribute("marker-end", `url(#arrow-${colorName})`);
			}
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
			this.statusNode.textContent = "Graph view is idle.";

			return;
		}

		const summary = `${result.stats.blockCount} blocks, ${result.stats.edgeCount} edges, ${result.stats.instructionCount} instructions`;
		const selected = this.selectedBlock();
		const selectedText = selected
			? ` Selected ${selected.title} (${selected.instructions.length} instructions).`
			: "";
		this.statusNode.textContent = `${result.message} ${summary}.${selectedText}`;
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
			return this.graphResult?.message || "No graph instructions available.";
		}
		if (this.graphResult) {
			return this.graphResult.message || "No graph instructions available.";
		}
		if (
			!this.followInstructionPointer &&
			this.manualAddress !== null &&
			!this.dumpInfo.findMemoryRangeAt(this.manualAddress)
		) {
			return "Enter an address that exists in dump memory to view a graph.";
		}
		if (this.resolvedContext) {
			if (
				this.followInstructionPointer &&
				this.resolvedContext.anchorAddress === null
			) {
				return "No instruction pointer available.";
			}
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
}
