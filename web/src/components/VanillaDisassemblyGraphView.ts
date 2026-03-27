import Graph from "graphology";
import Sigma from "sigma";
import type { Settings } from "sigma/settings";
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
	type CfgNode,
	layoutControlFlowGraph,
	type PositionedCfgGraph,
	type PositionedCfgNode,
} from "../lib/disassemblyGraph";
import type { ParsedDumpInfo } from "../lib/dumpInfo";

const DISASSEMBLY_GRAPH_PANEL_STATE_KEY =
	"wasm-dump-debugger:disassembly-graph-panel-state:v1";

type DisassemblyGraphViewPanelOptions = {
	container: HTMLElement;
	dumpInfo: ParsedDumpInfo;
	panelId: string;
};

type SigmaNodeAttributes = {
	x: number;
	y: number;
	size: number;
	color: string;
	label: string;
	compactLabel: string;
	fullLabel: string;
	estimatedWidth: number;
	estimatedHeight: number;
	kind: string;
	selected: boolean;
	anchor: boolean;
	hidden: boolean;
};

type SigmaEdgeAttributes = {
	color: string;
	size: number;
	label: string | null;
	kind: string;
	source: string;
	target: string;
	backedge: boolean;
	type: string;
};

const getPanelStorageKey = (panelId: string) =>
	`${DISASSEMBLY_GRAPH_PANEL_STATE_KEY}:${panelId}`;

const FULL_LABEL_PADDING_X = 8;
const FULL_LABEL_PADDING_Y = 6;
const CARD_FONT =
	'ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", Menlo, monospace';
const CARD_FONT_SIZE = 12;
const CARD_LINE_HEIGHT = CARD_FONT_SIZE + 3;
const EDGE_ARROW_LENGTH = 8;
const EDGE_ARROW_WIDTH = 5;

type ViewportCard = {
	id: string;
	node: PositionedCfgNode;
	centerX: number;
	centerY: number;
	x: number;
	y: number;
	width: number;
	height: number;
	lines: string[];
	selected: boolean;
	anchor: boolean;
	dimmed: boolean;
};

const drawRoundedRect = (
	context: CanvasRenderingContext2D,
	x: number,
	y: number,
	width: number,
	height: number,
	radius: number,
) => {
	const capped = Math.min(radius, width / 2, height / 2);
	context.beginPath();
	context.moveTo(x + capped, y);
	context.lineTo(x + width - capped, y);
	context.quadraticCurveTo(x + width, y, x + width, y + capped);
	context.lineTo(x + width, y + height - capped);
	context.quadraticCurveTo(
		x + width,
		y + height,
		x + width - capped,
		y + height,
	);
	context.lineTo(x + capped, y + height);
	context.quadraticCurveTo(x, y + height, x, y + height - capped);
	context.lineTo(x, y + capped);
	context.quadraticCurveTo(x, y, x + capped, y);
	context.closePath();
};

const clipLineToWidth = (
	context: CanvasRenderingContext2D,
	text: string,
	maxWidth: number,
) => {
	if (maxWidth <= 0) {
		return "";
	}
	if (context.measureText(text).width <= maxWidth) {
		return text;
	}
	const ellipsis = "...";
	let clipped = text;
	while (clipped.length > 0) {
		clipped = clipped.slice(0, -1);
		const next = `${clipped}${ellipsis}`;
		if (context.measureText(next).width <= maxWidth) {
			return next;
		}
	}
	return ellipsis;
};

const rectAnchorPoint = (
	centerX: number,
	centerY: number,
	halfWidth: number,
	halfHeight: number,
	dx: number,
	dy: number,
) => {
	if (dx === 0 && dy === 0) {
		return { x: centerX, y: centerY };
	}

	const safeHalfWidth = Math.max(halfWidth, 1);
	const safeHalfHeight = Math.max(halfHeight, 1);
	const scale =
		1 / Math.max(Math.abs(dx) / safeHalfWidth, Math.abs(dy) / safeHalfHeight);

	return {
		x: centerX + dx * scale,
		y: centerY + dy * scale,
	};
};

const drawArrowHead = (
	context: CanvasRenderingContext2D,
	fromX: number,
	fromY: number,
	toX: number,
	toY: number,
	color: string,
) => {
	const dx = toX - fromX;
	const dy = toY - fromY;
	const length = Math.hypot(dx, dy);
	if (length === 0) {
		return;
	}

	const unitX = dx / length;
	const unitY = dy / length;
	const baseX = toX - unitX * EDGE_ARROW_LENGTH;
	const baseY = toY - unitY * EDGE_ARROW_LENGTH;
	const normalX = -unitY * EDGE_ARROW_WIDTH;
	const normalY = unitX * EDGE_ARROW_WIDTH;

	context.beginPath();
	context.moveTo(toX, toY);
	context.lineTo(baseX + normalX, baseY + normalY);
	context.lineTo(baseX - normalX, baseY - normalY);
	context.closePath();
	context.fillStyle = color;
	context.fill();
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
	private readonly selectionNode: HTMLParagraphElement;
	private readonly graphHost: HTMLDivElement;
	private readonly graphOverlay: HTMLCanvasElement;

	private sigmaRenderer: Sigma<
		SigmaNodeAttributes,
		SigmaEdgeAttributes
	> | null = null;
	private positionedGraph: PositionedCfgGraph | null = null;
	private projectedCards: ViewportCard[] = [];
	private resizeObserver: ResizeObserver | null = null;

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
		if (this.projectedCards.length === 0) {
			if (this.selectedNodeId !== null) {
				this.selectedNodeId = null;
				this.syncStatus();
				this.syncSelectionSummary();
				this.redrawGraphOverlay();
			}
			return;
		}

		const bounds = this.graphHost.getBoundingClientRect();
		const clickX = event.clientX - bounds.left;
		const clickY = event.clientY - bounds.top;
		const hit = [...this.projectedCards]
			.reverse()
			.find(
				(card) =>
					clickX >= card.x &&
					clickX <= card.x + card.width &&
					clickY >= card.y &&
					clickY <= card.y + card.height,
			);

		this.selectedNodeId = hit?.id ?? null;
		this.syncStatus();
		this.syncSelectionSummary();
		this.redrawGraphOverlay();
	};

	private readonly redrawGraphOverlay = () => {
		const renderer = this.sigmaRenderer;
		const layout = this.positionedGraph;
		const canvas = this.graphOverlay;
		if (!renderer || !layout || layout.nodes.length === 0) {
			this.projectedCards = [];
			const context = canvas.getContext("2d");
			if (context) {
				context.setTransform(1, 0, 0, 1, 0, 0);
				context.clearRect(0, 0, canvas.width, canvas.height);
			}
			canvas.hidden = true;
			return;
		}

		const width = this.graphHost.clientWidth;
		const height = this.graphHost.clientHeight;
		if (width <= 0 || height <= 0) {
			return;
		}

		const pixelRatio = window.devicePixelRatio || 1;
		const nextCanvasWidth = Math.max(1, Math.round(width * pixelRatio));
		const nextCanvasHeight = Math.max(1, Math.round(height * pixelRatio));
		if (canvas.width !== nextCanvasWidth) {
			canvas.width = nextCanvasWidth;
		}
		if (canvas.height !== nextCanvasHeight) {
			canvas.height = nextCanvasHeight;
		}
		canvas.style.width = `${width}px`;
		canvas.style.height = `${height}px`;
		canvas.hidden = false;

		const context = canvas.getContext("2d");
		if (!context) {
			return;
		}

		context.setTransform(1, 0, 0, 1, 0, 0);
		context.clearRect(0, 0, canvas.width, canvas.height);
		context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
		context.font = `400 ${CARD_FONT_SIZE}px ${CARD_FONT}`;
		context.textBaseline = "top";

		this.projectedCards = layout.nodes.map((node) => {
			const center = renderer.graphToViewport({ x: node.x, y: node.y });
			const projectedWidth = node.width;
			const projectedHeight = node.height;
			const selected = node.id === this.selectedNodeId;
			const anchor = node.id === this.graphResult?.anchorNodeId;
			const dimmed = this.selectedNodeId !== null && !selected && !anchor;
			return {
				id: node.id,
				node,
				centerX: center.x,
				centerY: center.y,
				x: center.x - projectedWidth / 2,
				y: center.y - projectedHeight / 2,
				width: projectedWidth,
				height: projectedHeight,
				lines: node.fullLabel.split("\n"),
				selected,
				anchor,
				dimmed,
			};
		});

		for (const edge of layout.edges) {
			const source = this.projectedCards.find((card) => card.id === edge.from);
			const target = this.projectedCards.find((card) => card.id === edge.to);
			if (!source || !target) {
				continue;
			}

			const dimmed =
				this.selectedNodeId !== null &&
				edge.from !== this.selectedNodeId &&
				edge.to !== this.selectedNodeId;
			const strokeColor = dimmed ? "#D0D5DD" : edge.color;
			const dx = target.centerX - source.centerX;
			const dy = target.centerY - source.centerY;
			const start = rectAnchorPoint(
				source.centerX,
				source.centerY,
				source.width / 2 + 1,
				source.height / 2 + 1,
				dx,
				dy,
			);
			const end = rectAnchorPoint(
				target.centerX,
				target.centerY,
				target.width / 2 + 1,
				target.height / 2 + 1,
				-dx,
				-dy,
			);

			context.beginPath();
			context.moveTo(start.x, start.y);
			context.lineTo(end.x, end.y);
			context.lineWidth = dimmed ? 1.25 : Math.max(1.5, edge.size);
			context.strokeStyle = strokeColor;
			context.stroke();
			drawArrowHead(context, start.x, start.y, end.x, end.y, strokeColor);
		}

		const cardsInPaintOrder = [...this.projectedCards].sort(
			(leftCard, rightCard) => {
				const leftScore =
					(leftCard.selected ? 2 : 0) + (leftCard.anchor ? 1 : 0);
				const rightScore =
					(rightCard.selected ? 2 : 0) + (rightCard.anchor ? 1 : 0);
				return leftScore - rightScore;
			},
		);

		for (const card of cardsInPaintOrder) {
			const strokeColor = card.dimmed
				? "#CBD5E1"
				: card.selected
					? "#0F766E"
					: card.anchor
						? "#2563EB"
						: card.node.color;
			const fillColor = card.dimmed
				? "rgba(248, 250, 252, 0.94)"
				: card.selected
					? "rgba(240, 253, 250, 0.98)"
					: card.anchor
						? "rgba(239, 246, 255, 0.98)"
						: "rgba(255, 255, 255, 0.96)";
			const paddingX = FULL_LABEL_PADDING_X;
			const paddingY = FULL_LABEL_PADDING_Y;

			drawRoundedRect(context, card.x, card.y, card.width, card.height, 8);
			context.fillStyle = fillColor;
			context.fill();
			context.lineWidth = card.selected ? 2 : 1.25;
			context.strokeStyle = strokeColor;
			context.stroke();

			if (
				card.width < paddingX * 2 + 16 ||
				card.height < paddingY * 2 + CARD_LINE_HEIGHT
			) {
				continue;
			}

			context.save();
			context.beginPath();
			drawRoundedRect(context, card.x, card.y, card.width, card.height, 8);
			context.clip();
			context.font = `400 ${CARD_FONT_SIZE}px ${CARD_FONT}`;
			context.fillStyle = card.dimmed ? "#64748B" : "#0F172A";

			const maxTextWidth = Math.max(0, card.width - paddingX * 2);
			for (let index = 0; index < card.lines.length; index += 1) {
				const line = clipLineToWidth(context, card.lines[index], maxTextWidth);
				context.fillText(
					line,
					card.x + paddingX,
					card.y + paddingY + index * CARD_LINE_HEIGHT,
				);
			}
			context.restore();
		}
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
		this.selectionNode = dom.selectionNode;
		this.graphHost = dom.graphHost;
		this.graphOverlay = dom.graphOverlay;
		options.container.replaceChildren(this.root);

		this.root.addEventListener("submit", this.onAddressSubmit);
		this.followCheckbox.addEventListener("change", this.onFollowChange);
		this.graphHost.addEventListener("click", this.onGraphHostClick);
		if (typeof ResizeObserver !== "undefined") {
			this.resizeObserver = new ResizeObserver(() => {
				this.sigmaRenderer?.resize();
				this.redrawGraphOverlay();
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
		this.resizeObserver?.disconnect();
		this.resizeObserver = null;
		this.disposeSigma();
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
		const graphOverlay = document.createElement("canvas");
		graphOverlay.className = "disassembly-graph-view-panel__overlay";
		graphOverlay.hidden = true;
		graphOverlay.setAttribute("aria-hidden", "true");
		graphHost.append(graphOverlay);

		const selectionNode = document.createElement("p");
		selectionNode.className = "disassembly-graph-view-panel__selection";
		selectionNode.hidden = true;

		this.root.append(
			toolbar,
			statusNode,
			errorNode,
			emptyNode,
			graphHost,
			selectionNode,
		);
		return {
			addressInput,
			jumpButton,
			followCheckbox,
			statusNode,
			errorNode,
			emptyNode,
			selectionNode,
			graphHost,
			graphOverlay,
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

	private createSigmaSettings(): Partial<
		Settings<SigmaNodeAttributes, SigmaEdgeAttributes>
	> {
		return {
			renderLabels: false,
			renderEdgeLabels: false,
			hideLabelsOnMove: true,
			defaultEdgeType: "line",
			stagePadding: 64,
			allowInvalidContainer: true,
			zIndex: false,
		};
	}

	private disposeSigma() {
		this.sigmaRenderer?.kill();
		this.sigmaRenderer = null;
		this.positionedGraph = null;
		this.projectedCards = [];
		const context = this.graphOverlay.getContext("2d");
		if (context) {
			context.setTransform(1, 0, 0, 1, 0, 0);
			context.clearRect(
				0,
				0,
				this.graphOverlay.width,
				this.graphOverlay.height,
			);
		}
		this.graphOverlay.hidden = true;
		this.graphHost.replaceChildren(this.graphOverlay);
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
			this.disposeSigma();
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
			this.positionedGraph = null;
			this.disposeSigma();
			return;
		}

		const layout = layoutControlFlowGraph(this.graphResult);
		const graph = new Graph<SigmaNodeAttributes, SigmaEdgeAttributes>();
		for (const node of layout.nodes) {
			graph.addNode(node.id, {
				x: node.x,
				y: node.y,
				size: 1,
				color: node.color,
				label: node.compactLabel,
				compactLabel: node.compactLabel,
				fullLabel: node.fullLabel,
				estimatedWidth: node.width,
				estimatedHeight: node.height,
				kind: node.kind,
				selected: false,
				anchor: node.id === this.graphResult.anchorNodeId,
				hidden: true,
			});
		}

		this.disposeSigma();
		this.positionedGraph = layout;
		this.graphHost.hidden = false;
		this.graphOverlay.hidden = false;
		this.sigmaRenderer = new Sigma(
			graph,
			this.graphHost,
			this.createSigmaSettings(),
		);
		this.sigmaRenderer.on("afterRender", this.redrawGraphOverlay);
		this.sigmaRenderer.on("resize", this.redrawGraphOverlay);
		const xValues = layout.nodes.flatMap((node) => [
			node.x - node.width / 2,
			node.x + node.width / 2,
		]);
		const yValues = layout.nodes.flatMap((node) => [
			node.y - node.height / 2,
			node.y + node.height / 2,
		]);
		this.sigmaRenderer.setCustomBBox({
			x: [Math.min(...xValues), Math.max(...xValues)],
			y: [Math.min(...yValues), Math.max(...yValues)],
		});
		void this.sigmaRenderer.getCamera().animatedReset({ duration: 150 });
		this.syncSelectionSummary();
		this.sigmaRenderer.resize();
		this.redrawGraphOverlay();
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
			this.syncSelectionSummary();
			return;
		}

		const summary = `${result.stats.blockCount} blocks, ${result.stats.edgeCount} edges, ${result.stats.instructionCount} instructions`;
		const selected = this.selectedBlock();
		const selectedText = selected
			? ` Selected ${selected.title} (${selected.instructions.length} instructions).`
			: "";
		this.statusNode.textContent = `${result.message} ${summary}.${selectedText}`;
		this.syncSelectionSummary();
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

	private syncSelectionSummary() {
		const selected = this.selectedBlock();
		if (!selected) {
			this.selectionNode.hidden = true;
			this.selectionNode.textContent = "";
			return;
		}

		this.selectionNode.hidden = false;
		this.selectionNode.textContent =
			selected.kind === "block"
				? `Selected ${selected.title} with ${selected.instructions.length} instruction${selected.instructions.length === 1 ? "" : "s"}.`
				: `Selected ${selected.title}.`;
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
