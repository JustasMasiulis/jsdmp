import type {
	GroupPanelPartInitParameters,
	IContentRenderer,
} from "dockview-core";
import { AddressToolbar } from "../lib/addressToolbar";
import { triskelBuildRenderGraph } from "../lib/analysis/triskel-adapter";
import type { CpuContext } from "../lib/cpu_context";
import { DBG } from "../lib/debugState";
import {
	buildCfg2,
	type CfgBuildResult,
	type CfgEdgeKind,
	type CfgNode,
	estimateNodeDimensions,
	getCfgLineAddress,
} from "../lib/disassemblyGraph";
import { fmtHex16 } from "../lib/formatting";
import {
	type AnnotatedCfgDescriptor,
	type AnnotatedNodeDescriptor,
	type EdgeColor,
	type EdgeDescriptor,
	GraphLayoutCore,
} from "../lib/graph-layout-core";
import {
	buildNativeCfgCompareJson,
	downloadTextFile,
	NATIVE_CFG_COMPARE_KEYBIND,
	requestNativeCfgCompareSvg,
} from "../lib/nativeCfgCompare";
import type { SignalHandle } from "../lib/reactive";
import { BlockTextRenderer } from "../rendering/blockTextProgram";
import { CfgGraphRenderer } from "../rendering/cfgGraphRenderer";
import { CfgInteractionHandler } from "../rendering/cfgInteractionHandler";
import { buildRenderGraph } from "../rendering/cfgRenderGraph";
import { CfgSelectionLayer } from "../rendering/cfgSelectionLayer";
import { EdgePolylineRenderer } from "../rendering/edgePolylineProgram";

const PANEL_STATE_KEY = "wasm-dump-debugger:disassembly-graph-panel-state:v1";

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

export class DisassemblyGraphView implements IContentRenderer {
	private readonly toolbar: AddressToolbar;
	private readonly contextHandle: SignalHandle<CpuContext | null>;
	private graphResult: CfgBuildResult | null = null;
	private isLoadingGraph = false;
	private isDisposed = false;
	private reloadToken = 0;

	private useTriskelLayout = false;
	private isExportingNativeCompare = false;
	private nativeCompareStatus: string | null = null;

	private readonly statusNode: HTMLParagraphElement;
	private readonly compareButton: HTMLButtonElement;
	private readonly graphHost: HTMLDivElement;

	private nodesById: Map<string, CfgNode> | null = null;
	private graphRenderer: CfgGraphRenderer | null = null;
	private edgeRenderer: EdgePolylineRenderer | null = null;
	private textRenderer: BlockTextRenderer | null = null;
	private selectionLayer: CfgSelectionLayer | null = null;
	private interactionHandler: CfgInteractionHandler | null = null;
	private pendingFit: (() => void) | null = null;

	element: HTMLElement;

	private readonly onDisasmLinkClick = (event: MouseEvent) => {
		const target = (event.target as HTMLElement).closest<HTMLElement>(
			".disasm-link[data-target-address]",
		);
		if (!target) return;
		const hex = target.dataset.targetAddress;
		if (!hex) return;
		event.preventDefault();
		event.stopPropagation();
		const address = BigInt(`0x${hex}`);
		this.toolbar.navigateToAddress(address);
	};

	private readonly onGraphKeyDown = (event: KeyboardEvent) => {
		const key = event.key.toLowerCase();
		if (key === "l" && event.altKey && !event.ctrlKey && !event.metaKey) {
			event.preventDefault();
			this.useTriskelLayout = !this.useTriskelLayout;
			this.refreshView(true);
			console.log(
				`Switched to ${this.useTriskelLayout ? "Triskel" : "GraphLayoutCore"} layout.`,
			);
			return;
		}

		if (
			key === "s" &&
			event.altKey &&
			event.shiftKey &&
			!event.ctrlKey &&
			!event.metaKey
		) {
			event.preventDefault();
			void this.exportNativeCompare();
		}
	};

	private readonly onCompareButtonClick = () => {
		void this.exportNativeCompare();
	};

	constructor(element: HTMLElement, panelId: string) {
		this.element = element;
		this.element.setAttribute(
			"aria-label",
			`Disassembly graph view ${panelId}`,
		);

		this.toolbar = new AddressToolbar(this.element, {
			panelId,
			storageKey: `${PANEL_STATE_KEY}:${panelId}`,
			defaultSync: true,
			onNavigate: () => this.refreshView(true),
			onFocusAddress: (addr) => this.focusAddress(addr),
			emptyMessage: () => this.emptyMessage(),
		});

		const statusNode = document.createElement("p");
		statusNode.className = "disassembly-graph-view-panel__status";
		this.statusNode = statusNode;

		const compareButton = document.createElement("button");
		compareButton.type = "button";
		compareButton.className =
			"memory-view-panel__button disassembly-graph-view-panel__button";
		compareButton.textContent = "Native SVG";
		compareButton.title = `Export the current CFG as JSON and render it with native Triskel (${NATIVE_CFG_COMPARE_KEYBIND})`;
		this.compareButton = compareButton;

		const statusBar = document.createElement("div");
		statusBar.className = "disassembly-graph-view-panel__status-row";
		statusBar.append(statusNode, compareButton);

		const graphHost = document.createElement("div");
		graphHost.className = "disassembly-graph-view-panel__graph";
		graphHost.hidden = true;
		graphHost.style.position = "relative";
		this.graphHost = graphHost;

		this.element.append(statusBar, graphHost);

		this.element.tabIndex = 0;
		this.element.addEventListener("keydown", this.toolbar.onKeyDown);
		this.element.addEventListener("keydown", this.onGraphKeyDown);
		this.element.addEventListener("click", this.onDisasmLinkClick);
		this.compareButton.addEventListener("click", this.onCompareButtonClick);

		this.contextHandle = DBG.currentContext.subscribe(() =>
			this.onContextChanged(),
		);

		this.refreshView(true);
	}

	init(_: GroupPanelPartInitParameters): void {}

	private onContextChanged() {
		if (this.isDisposed) return;
		this.graphResult = null;
		this.refreshView(true);
	}

	dispose() {
		if (this.isDisposed) return;
		this.isDisposed = true;
		this.toolbar.dispose();
		this.contextHandle.dispose();
		this.element.removeEventListener("keydown", this.toolbar.onKeyDown);
		this.element.removeEventListener("keydown", this.onGraphKeyDown);
		this.element.removeEventListener("click", this.onDisasmLinkClick);
		this.compareButton.removeEventListener("click", this.onCompareButtonClick);
		this.disposeGraph();
		this.element.replaceChildren();
	}

	private disposeGraph() {
		if (this.pendingFit && this.graphRenderer) {
			this.graphRenderer.offRender(this.pendingFit);
		}
		this.pendingFit = null;
		this.interactionHandler?.dispose();
		this.interactionHandler = null;
		this.selectionLayer?.dispose();
		this.selectionLayer = null;
		this.textRenderer?.dispose();
		this.textRenderer = null;
		this.edgeRenderer?.dispose();
		this.edgeRenderer = null;
		this.graphRenderer?.dispose();
		this.graphRenderer = null;
		this.nodesById = null;
		this.graphHost.replaceChildren();
	}

	private refreshView(reloadGraph: boolean) {
		this.toolbar.syncDisplayedAddress();
		if (reloadGraph) {
			void this.reloadGraph();
			return;
		}
		this.syncStatus();
		this.syncControlState();
	}

	private async reloadGraph() {
		const token = ++this.reloadToken;
		const anchorAddress = this.toolbar.currentAnchor();
		this.isLoadingGraph = true;
		this.nativeCompareStatus = null;

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

		this.disposeGraph();

		const result = this.graphResult;
		const graph = this.useTriskelLayout
			? triskelBuildRenderGraph(result)
			: (() => {
					const descriptor = cfgResultToAnnotatedDescriptor(result);
					const layoutCore = new GraphLayoutCore(descriptor, true, true);
					return buildRenderGraph(result, layoutCore);
				})();

		this.graphHost.hidden = false;

		this.nodesById = new Map<string, CfgNode>(
			this.graphResult.blocks.map((node) => [node.id, node]),
		);
		const nodesById = this.nodesById;

		const bboxRange = Math.max(
			graph.bbox.x[1] - graph.bbox.x[0],
			graph.bbox.y[1] - graph.bbox.y[0],
			1,
		);

		const MIN_VISIBLE_GRAPH_SPAN = 480;
		const minRatio = MIN_VISIBLE_GRAPH_SPAN / bboxRange;

		const vpW = this.graphHost.clientWidth;
		const vpH = this.graphHost.clientHeight;
		const maxZoomOutRatio = (bboxRange / Math.min(vpW || 1, vpH || 1)) * 1.5;

		const renderer = new CfgGraphRenderer(this.graphHost, graph, {
			minRatio,
			maxRatio: Math.max(maxZoomOutRatio, minRatio, 1),
		});
		this.graphRenderer = renderer;

		this.edgeRenderer = new EdgePolylineRenderer(renderer, graph);
		this.textRenderer = new BlockTextRenderer(renderer, graph, nodesById);
		this.selectionLayer = new CfgSelectionLayer(renderer, graph, nodesById);
		this.interactionHandler = new CfgInteractionHandler(
			renderer,
			graph,
			this.textRenderer,
			nodesById,
			(selectionStatus) => {
				this.syncStatus(selectionStatus);
			},
			(address) => {
				this.toolbar.selectAddress(address);
			},
			(address) => {
				this.toolbar.focusInView(address);
			},
		);

		const fit = () => {
			const { width, height } = renderer.getDimensions();
			if (width <= 0 || height <= 0) return;
			renderer.offRender(fit);
			this.pendingFit = null;
			const maxZoom = (bboxRange / Math.min(width, height)) * 1.5;
			renderer.setZoomBounds(minRatio, Math.max(maxZoom, minRatio, 1));
			this.interactionHandler?.fitToView();
		};
		this.pendingFit = fit;
		renderer.onRender(fit);
		renderer.requestRender();

		this.syncStatus();
		this.syncControlState();
	}

	private syncStatus(selectionStatus?: string) {
		const result = this.graphResult;
		const compareStatus = this.isExportingNativeCompare
			? " Exporting native SVG..."
			: this.nativeCompareStatus
				? ` ${this.nativeCompareStatus}`
				: "";
		if (!result) {
			this.statusNode.textContent = this.isLoadingGraph
				? "Loading graph..."
				: `Graph view is idle.${compareStatus}`;
			return;
		}

		const summary = `${result.stats.blockCount} blocks, ${result.stats.edgeCount} edges, ${result.stats.instructionCount} instr`;
		const extra = selectionStatus ? ` ${selectionStatus}` : "";
		this.statusNode.textContent = `${summary}.${extra}${compareStatus}`;
	}

	private syncControlState() {
		const hasGraph = (this.graphResult?.blocks.length ?? 0) > 0;
		this.toolbar.syncControlState(hasGraph);
		this.graphHost.hidden = !hasGraph;
		this.compareButton.disabled =
			!hasGraph || this.isLoadingGraph || this.isExportingNativeCompare;
		this.compareButton.textContent = this.isExportingNativeCompare
			? "Exporting..."
			: "Native SVG";
	}

	private async exportNativeCompare() {
		if (
			this.isExportingNativeCompare ||
			!this.graphResult ||
			this.graphResult.blocks.length === 0
		) {
			return;
		}

		const result = this.graphResult;
		const previewWindow = window.open("", "_blank");
		if (previewWindow) {
			previewWindow.document.title = "Generating native CFG SVG";
			previewWindow.document.body.textContent =
				"Generating native Triskel SVG comparison...";
		}

		this.isExportingNativeCompare = true;
		this.nativeCompareStatus = null;
		this.syncStatus();
		this.syncControlState();

		try {
			const { baseName, jsonText } = buildNativeCfgCompareJson(result);
			downloadTextFile(`${baseName}.json`, jsonText, "application/json");

			const svgText = await requestNativeCfgCompareSvg(jsonText);
			if (previewWindow && !previewWindow.closed) {
				const svgUrl = URL.createObjectURL(
					new Blob([svgText], { type: "image/svg+xml;charset=utf-8" }),
				);
				previewWindow.location.replace(svgUrl);
				setTimeout(() => URL.revokeObjectURL(svgUrl), 60_000);
				this.nativeCompareStatus = `Opened native SVG (${NATIVE_CFG_COMPARE_KEYBIND}).`;
			} else {
				downloadTextFile(`${baseName}.svg`, svgText, "image/svg+xml");
				this.nativeCompareStatus = "Downloaded native SVG comparison.";
			}
		} catch (error) {
			const message =
				error instanceof Error ? error.message : "Native comparison failed.";
			this.nativeCompareStatus = `Native SVG export failed: ${message}`;
			if (previewWindow && !previewWindow.closed) {
				previewWindow.document.title = "Native CFG SVG failed";
				previewWindow.document.body.textContent = this.nativeCompareStatus;
			}
		} finally {
			this.isExportingNativeCompare = false;
			this.syncStatus();
			this.syncControlState();
		}
	}

	private focusAddress(address: bigint): boolean {
		if (!this.interactionHandler || !this.nodesById || !this.textRenderer)
			return false;
		const hit = this.findLineForAddress(address);
		if (!hit) return false;
		this.textRenderer.highlightLineAddress(fmtHex16(address));
		this.interactionHandler.focusLine(hit.blockId, hit.lineIndex);
		return true;
	}

	private findLineForAddress(
		address: bigint,
	): { blockId: string; lineIndex: number } | null {
		if (!this.nodesById) return null;
		for (const [id, node] of this.nodesById) {
			for (let i = 0; i < node.lines.length; i++) {
				if (getCfgLineAddress(node.lines[i]) === address)
					return { blockId: id, lineIndex: i };
			}
		}
		return null;
	}

	private emptyMessage() {
		if (this.graphResult) return "No graph instructions available.";
		if (this.isLoadingGraph) return "Loading graph...";
		if (
			!this.toolbar.followInstructionPointer &&
			this.toolbar.manualAddress !== null
		)
			return "Enter an address that exists in dump memory to view a graph.";
		if (
			this.toolbar.followInstructionPointer &&
			DBG.currentContext.state?.ip == null
		)
			return "No instruction pointer available.";
		return "Disassembly graph view is unavailable for this dump.";
	}
}
