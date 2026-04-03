import type { IContentRenderer } from "dockview-core";
import Sigma from "sigma";
import {
	loadAddressPanelState,
	parseHexAddress,
	saveAddressPanelState,
} from "../lib/addressPanelState";
import { buildGraphologyGraph } from "../lib/cfgGraphologyAdapter";
import type { Context } from "../lib/cpu_context";
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
import { BlockTextRenderer } from "../rendering/blockTextProgram";
import { CfgInteractionHandler } from "../rendering/cfgInteractionHandler";
import { CfgSelectionLayer } from "../rendering/cfgSelectionLayer";
import { EdgePolylineRenderer } from "../rendering/edgePolylineProgram";

const PANEL_STATE_KEY = "wasm-dump-debugger:disassembly-graph-panel-state:v1";

type SigmaGraphViewOptions = {
	container: HTMLElement;
	panelId: string;
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

export class SigmaDisassemblyGraphView implements IContentRenderer {
	private readonly panelId: string;
	private readonly contextHandle: SignalHandle<Context | null>;
	private graphResult: CfgBuildResult | null = null;
	private followInstructionPointer = true;
	private manualAddress: bigint | null = null;
	private addressError = "";
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

	private sigmaInstance: Sigma | null = null;
	private edgeRenderer: EdgePolylineRenderer | null = null;
	private textRenderer: BlockTextRenderer | null = null;
	private selectionLayer: CfgSelectionLayer | null = null;
	private interactionHandler: CfgInteractionHandler | null = null;
	private resizeObserver: ResizeObserver | null = null;
	private pendingSigmaSetup: (() => void) | null = null;

	private readonly onFollowChange = () => {
		const next = this.followCheckbox.checked;
		this.followInstructionPointer = next;
		if (!next && this.manualAddress === null) {
			const ip = DBG.currentContext.state?.ip ?? null;
			if (ip !== null) {
				this.manualAddress = ip;
			}
		}
		this.clearAddressError();
		this.saveState();
		this.refreshView(true);
	};

	private readonly onAddressSubmit = (event: Event) => {
		event.preventDefault();
		void this.submitAddress();
	};

	private readonly onDisasmLinkClick = (event: MouseEvent) => {
		const target = (event.target as HTMLElement).closest<HTMLElement>(
			".disasm-link[data-target-address]",
		);
		if (!target) return;
		const hex = target.dataset.targetAddress;
		if (!hex) return;
		event.preventDefault();
		event.stopPropagation();
		const address = BigInt("0x" + hex);
		this.manualAddress = address;
		this.followInstructionPointer = false;
		this.followCheckbox.checked = false;
		this.clearAddressError();
		this.saveState();
		this.refreshView(true);
	};

	constructor(options: SigmaGraphViewOptions) {
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
		this.root.addEventListener("click", this.onDisasmLinkClick);
		this.followCheckbox.addEventListener("change", this.onFollowChange);

		this.contextHandle = DBG.currentContext.subscribe(() => this.update());

		this.restoreState();
		this.refreshView(true);
	}

	get element() {
		return this.root;
	}

	private update() {
		if (this.isDisposed) return;
		this.graphResult = null;
		this.clearAddressError();
		this.refreshView(true);
	}

	dispose() {
		if (this.isDisposed) return;
		this.isDisposed = true;
		this.contextHandle.dispose();
		this.root.removeEventListener("submit", this.onAddressSubmit);
		this.root.removeEventListener("click", this.onDisasmLinkClick);
		this.followCheckbox.removeEventListener("change", this.onFollowChange);
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
		graphHost.style.position = "relative";

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
		const storageKey = `${PANEL_STATE_KEY}:${this.panelId}`;
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
		const storageKey = `${PANEL_STATE_KEY}:${this.panelId}`;
		saveAddressPanelState(storageKey, {
			manualAddressHex:
				this.manualAddress !== null ? `0x${fmtHex16(this.manualAddress)}` : "",
			followInstructionPointer: this.followInstructionPointer,
		});
	}

	private disposeGraph() {
		this.resizeObserver?.disconnect();
		this.resizeObserver = null;
		this.pendingSigmaSetup = null;
		this.interactionHandler?.dispose();
		this.interactionHandler = null;
		this.selectionLayer?.dispose();
		this.selectionLayer = null;
		this.textRenderer?.dispose();
		this.textRenderer = null;
		this.edgeRenderer?.dispose();
		this.edgeRenderer = null;
		this.sigmaInstance?.kill();
		this.sigmaInstance = null;
		this.graphHost.replaceChildren();
	}

	private currentAnchor() {
		if (this.followInstructionPointer) {
			return DBG.currentContext.state?.ip ?? null;
		}
		return this.manualAddress ?? null;
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
			if (this.isDisposed || token !== this.reloadToken) return;
			this.graphResult = nextGraph;
		} catch {
			if (this.isDisposed || token !== this.reloadToken) return;
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
			if (this.isDisposed || token !== this.reloadToken) return;
			this.isLoadingGraph = false;
		}

		if (!this.graphResult || this.graphResult.blocks.length === 0) {
			this.disposeGraph();
			this.syncStatus();
			this.syncControlState();
			return;
		}

		const descriptor = cfgResultToAnnotatedDescriptor(this.graphResult);
		this.disposeGraph();

		const layoutCore = new GraphLayoutCore(descriptor, true, true);
		const graph = buildGraphologyGraph(this.graphResult, layoutCore);

		this.graphHost.hidden = false;

		const totalWidth = layoutCore.getWidth();
		const totalHeight = layoutCore.getHeight();
		const nodesById = new Map<string, CfgNode>(
			this.graphResult.blocks.map((node) => [node.id, node]),
		);

		const setupSigma = () => {
			if (this.isDisposed) return;

			const sigma = new Sigma(graph, this.graphHost, {
				allowInvalidContainer: true,
				renderLabels: false,
				renderEdgeLabels: false,
				enableEdgeEvents: false,
				nodeReducer: () => ({
					hidden: true,
					color: "#000",
					label: "",
					size: 1,
					x: 0,
					y: 0,
				}),
				edgeReducer: () => ({
					hidden: true,
					color: "#000",
					label: "",
					size: 0,
				}),
				minCameraRatio: null,
				maxCameraRatio: null,
				zoomingRatio: 1.3,
				autoRescale: false,
				autoCenter: false,
				itemSizesReference: "positions",
			});

			this.sigmaInstance = sigma;

			sigma.setCustomBBox({
				x: [0, totalWidth],
				y: [-totalHeight, 0],
			});

			const { width: vpW, height: vpH } = sigma.getDimensions();
			const bboxRange = Math.max(totalWidth, totalHeight);
			const MIN_VISIBLE_GRAPH_SPAN = 480;
			const maxZoomInRatio = MIN_VISIBLE_GRAPH_SPAN / bboxRange;
			const maxZoomOutRatio = (bboxRange / Math.min(vpW, vpH)) * 1.5;

			const minRatio = maxZoomInRatio;
			const maxRatio = Math.max(maxZoomOutRatio, minRatio, 1);
			sigma.setSetting("minCameraRatio", minRatio);
			sigma.setSetting("maxCameraRatio", maxRatio);

			const mouseCaptor = sigma.getMouseCaptor();
			for (const evt of [
				"mousemove",
				"mousemovebody",
				"click",
				"rightClick",
				"doubleClick",
				"wheel",
				"mousedown",
				"mouseup",
				"mouseleave",
				"mouseenter",
			] as const) {
				mouseCaptor.removeAllListeners(evt);
			}
			const touchCaptor = sigma.getTouchCaptor();
			for (const evt of ["touchdown", "touchup", "touchmove"] as const) {
				touchCaptor.removeAllListeners(evt);
			}

			this.edgeRenderer = new EdgePolylineRenderer(sigma, graph);
			this.textRenderer = new BlockTextRenderer(sigma, graph, nodesById);
			this.selectionLayer = new CfgSelectionLayer(sigma, graph, nodesById);
			this.interactionHandler = new CfgInteractionHandler(
				sigma,
				graph,
				this.textRenderer,
				nodesById,
				(selectionStatus) => {
					this.syncStatus(selectionStatus);
				},
			);

			this.interactionHandler.fitToView();
			sigma.refresh();
		};

		if (this.graphHost.clientWidth > 0 && this.graphHost.clientHeight > 0) {
			setupSigma();
		} else {
			this.pendingSigmaSetup = setupSigma;
			this.resizeObserver = new ResizeObserver((entries) => {
				for (const entry of entries) {
					if (entry.contentRect.width > 0 && entry.contentRect.height > 0) {
						this.resizeObserver?.disconnect();
						this.resizeObserver = null;
						const pending = this.pendingSigmaSetup;
						this.pendingSigmaSetup = null;
						pending?.();
						break;
					}
				}
			});
			this.resizeObserver.observe(this.graphHost);
		}

		this.syncStatus();
		this.syncControlState();
	}

	private syncDisplayedAddress() {
		const address = this.currentAnchor();
		this.addressInput.value = address !== null ? `0x${fmtHex16(address)}` : "";
	}

	private syncStatus(selectionStatus?: string) {
		const result = this.graphResult;
		if (!result) {
			this.statusNode.textContent = this.isLoadingGraph
				? "Loading graph..."
				: "Graph view is idle.";
			return;
		}

		const summary = `${result.stats.blockCount} blocks, ${result.stats.edgeCount} edges, ${result.stats.instructionCount} instr`;
		const extra = selectionStatus ? ` ${selectionStatus}` : "";
		this.statusNode.textContent = `${summary}.${extra}`;
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
		if (this.addressError) return "No graph instructions available.";
		if (this.graphResult) return "No graph instructions available.";
		if (this.isLoadingGraph) return "Loading graph...";
		if (!this.followInstructionPointer && this.manualAddress !== null)
			return "Enter an address that exists in dump memory to view a graph.";
		if (this.followInstructionPointer && DBG.currentContext.state?.ip == null)
			return "No instruction pointer available.";
		return "Disassembly graph view is unavailable for this dump.";
	}

	private setAddressError(message: string) {
		this.addressError = message;
		this.syncControlState();
	}

	private clearAddressError() {
		if (!this.addressError) return;
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
		this.clearAddressError();
		this.saveState();
		this.refreshView(true);
	}
}
