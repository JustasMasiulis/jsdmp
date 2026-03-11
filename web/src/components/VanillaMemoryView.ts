import type { ParsedDumpInfo } from "./DumpSummary";

const BYTES_PER_ROW = 16;
const ROW_HEIGHT_PX = 20;
const OVERSCAN_ROWS = 10;
const DEFAULT_VIEWPORT_HEIGHT_PX = 320;
const WHEEL_ROWS_PER_TICK = 2;
const MEMORY_PANEL_STATE_KEY = "wasm-dump-debugger:memory-panel-state:v1";
const BROWSER_MAX_VIRTUAL_HEIGHT_PX = navigator.userAgent
	.toLowerCase()
	.includes("firefox")
	? 5_000_000
	: 10_000_000;

type MemoryViewPanelOptions = {
	container: HTMLElement;
	dumpInfo: ParsedDumpInfo;
	panelId: string;
};

type MemorySpan = {
	start: bigint;
	endExclusive: bigint;
};

type MemoryPanelSavedState = {
	manualAddressHex?: string;
	followInstructionPointer?: boolean;
};

export type VirtualListingColumnSpec = {
	title: string;
	cellClassName?: string;
};

type VirtualListingCellDom = {
	cell: HTMLDivElement;
	code: HTMLElement;
};

export type VirtualListingAdapter<TRowState> = {
	columns: readonly VirtualListingColumnSpec[];
	gridTemplateColumns: string;
	createRowState: (cells: readonly VirtualListingCellDom[]) => TRowState;
	renderRow: (rowIndex: number, rowState: TRowState) => void;
	getRowClassName?: (rowIndex: number, rowState: TRowState) => string;
};

type VirtualRowDom<TRowState> = {
	element: HTMLDivElement;
	state: TRowState;
};

type ViewportWindow = {
	renderStart: number;
	renderEnd: number;
	rowsOffsetPx: number;
	viewportRows: number;
};

type FixedRowVirtualTableOptions<TRowState> = {
	adapter: VirtualListingAdapter<TRowState>;
	rowHeightPx: number;
	overscanRows: number;
	defaultViewportHeightPx: number;
	wheelRowsPerTick: number;
};

type MemoryRowState = {
	addressCode: HTMLElement;
	hexCode: HTMLElement;
	asciiCode: HTMLElement;
	hexParts: string[];
	asciiParts: string[];
};

const fmtAddress = (value: bigint) =>
	value.toString(16).toUpperCase().padStart(16, "0");

const fmtByte = (value: number) =>
	value.toString(16).toUpperCase().padStart(2, "0");

const toAscii = (value: number) =>
	value >= 0x20 && value <= 0x7e ? String.fromCharCode(value) : ".";

const parseHexAddress = (value: string): bigint | null => {
	const trimmed = value.trim();
	if (!trimmed) {
		return null;
	}

	const normalized =
		trimmed.startsWith("0x") || trimmed.startsWith("0X")
			? trimmed.slice(2)
			: trimmed;
	if (!/^[0-9a-fA-F]+$/.test(normalized)) {
		return null;
	}

	try {
		return BigInt(`0x${normalized}`);
	} catch {
		return null;
	}
};

const parsePanelIndex = (panelId: string): number => {
	if (panelId === "memory") {
		return 1;
	}

	const match = /^memory-(\d+)$/.exec(panelId);
	if (!match) {
		return 1;
	}

	return Number.parseInt(match[1], 10) || 1;
};

const isInSpan = (address: bigint, span: MemorySpan) =>
	address >= span.start && address < span.endExclusive;

const clampAddressToSpan = (address: bigint, span: MemorySpan): bigint => {
	if (address < span.start) {
		return span.start;
	}
	if (address >= span.endExclusive) {
		return span.endExclusive - 1n;
	}
	return address;
};

const alignDownToRow = (address: bigint, spanStart: bigint): bigint => {
	if (address <= spanStart) {
		return spanStart;
	}

	const offset = address - spanStart;
	const alignedOffset = offset - (offset % BigInt(BYTES_PER_ROW));
	return spanStart + alignedOffset;
};

const getPanelStorageKey = (panelId: string) =>
	`${MEMORY_PANEL_STATE_KEY}:${panelId}`;

const minBigInt = (a: bigint, b: bigint) => (a < b ? a : b);

class FixedRowVirtualTable<TRowState> {
	private readonly adapter: VirtualListingAdapter<TRowState>;
	private readonly rowHeightPx: number;
	private readonly overscanRows: number;
	private readonly defaultViewportHeightPx: number;
	private readonly wheelRowsPerTick: number;

	private rowCount = 0;
	private virtualPanelHeightPx = 1;
	private scrollTop = 0;
	private logicalStartRow = 0;
	private ignoreScrollEvent = false;
	private viewportHeight: number;
	private visibleStart = -1;
	private visibleEnd = -1;
	private forceRowsRefresh = true;
	private rafId = 0;
	private resizeObserver: ResizeObserver | undefined;
	private isDisposed = false;

	private readonly tableNode: HTMLDivElement;
	private readonly viewportNode: HTMLDivElement;
	private readonly virtualPanelNode: HTMLDivElement;
	private readonly rowsNode: HTMLDivElement;
	private readonly rowPool: VirtualRowDom<TRowState>[] = [];

	private readonly onScroll = () => {
		if (this.ignoreScrollEvent) {
			this.ignoreScrollEvent = false;
			return;
		}
		this.scrollTop = this.viewportNode.scrollTop;
		this.logicalStartRow = this.startRowFromScrollTop(this.scrollTop);
		this.requestRender(false);
	};

	private readonly onWheel = (event: WheelEvent) => {
		if (this.rowCount === 0 || event.deltaY === 0) {
			return;
		}

		event.preventDefault();
		const direction = event.deltaY > 0 ? 1 : -1;
		this.logicalStartRow = this.clampStartRow(
			this.logicalStartRow + direction * this.wheelRowsPerTick,
		);
		const nextScrollTop = this.scrollTopFromStartRow(this.logicalStartRow);
		this.scrollTop = nextScrollTop;
		if (Math.abs(this.viewportNode.scrollTop - nextScrollTop) > 0.01) {
			this.ignoreScrollEvent = true;
			this.viewportNode.scrollTop = nextScrollTop;
		}
		this.requestRender(false);
	};

	constructor(options: FixedRowVirtualTableOptions<TRowState>) {
		this.adapter = options.adapter;
		this.rowHeightPx = options.rowHeightPx;
		this.overscanRows = options.overscanRows;
		this.defaultViewportHeightPx = options.defaultViewportHeightPx;
		this.wheelRowsPerTick = options.wheelRowsPerTick;
		this.viewportHeight = options.defaultViewportHeightPx;
		const dom = this.createDomTree();
		this.tableNode = dom.tableNode;
		this.viewportNode = dom.viewportNode;
		this.virtualPanelNode = dom.virtualPanelNode;
		this.rowsNode = dom.rowsNode;

		this.tableNode.style.setProperty(
			"--memory-view-grid-template",
			this.adapter.gridTemplateColumns,
		);
		this.tableNode.style.setProperty(
			"--memory-view-row-height",
			`${this.rowHeightPx}px`,
		);

		this.viewportNode.addEventListener("scroll", this.onScroll, {
			passive: true,
		});
		this.viewportNode.addEventListener("wheel", this.onWheel, {
			passive: false,
		});

		this.resizeObserver = new ResizeObserver(() => {
			this.viewportHeight =
				this.viewportNode.clientHeight || this.defaultViewportHeightPx;
			this.requestRender(true);
		});
		this.resizeObserver.observe(this.viewportNode);
		this.requestRender(true);
	}

	get element() {
		return this.tableNode;
	}

	setRowCount(nextRowCount: number) {
		const rowCount = Math.max(
			0,
			Math.floor(Number.isFinite(nextRowCount) ? nextRowCount : 0),
		);
		this.rowCount = rowCount;
		this.virtualPanelHeightPx = Math.max(
			1,
			Math.min(BROWSER_MAX_VIRTUAL_HEIGHT_PX, rowCount * this.rowHeightPx),
		);
		this.logicalStartRow = this.clampStartRow(this.logicalStartRow);
		this.visibleStart = -1;
		this.visibleEnd = -1;
		this.requestRender(true);
	}

	scrollToRow(rowOffset: number) {
		this.logicalStartRow = this.clampStartRow(rowOffset);
		const nextScrollTop = this.scrollTopFromStartRow(this.logicalStartRow);
		this.ignoreScrollEvent = true;
		this.viewportNode.scrollTop = nextScrollTop;
		this.scrollTop = nextScrollTop;
		this.requestRender(true);
	}

	requestRender(forceRows: boolean) {
		if (forceRows) {
			this.forceRowsRefresh = true;
		}

		if (this.rafId !== 0 || this.isDisposed) {
			return;
		}

		this.rafId = requestAnimationFrame(() => {
			this.rafId = 0;
			this.render();
		});
	}

	dispose() {
		if (this.isDisposed) {
			return;
		}

		this.isDisposed = true;
		if (this.rafId !== 0) {
			cancelAnimationFrame(this.rafId);
			this.rafId = 0;
		}
		this.resizeObserver?.disconnect();
		this.viewportNode.removeEventListener("scroll", this.onScroll);
		this.viewportNode.removeEventListener("wheel", this.onWheel);
		this.tableNode.replaceChildren();
	}

	private getViewportRows() {
		return this.viewportHeight / this.rowHeightPx;
	}

	private getScrollableRows(viewportRows = this.getViewportRows()) {
		return Math.max(0, this.rowCount - viewportRows);
	}

	private clampStartRow(startRow: number, viewportRows = this.getViewportRows()) {
		const max = this.getScrollableRows(viewportRows);
		return Math.max(0, Math.min(max, startRow));
	}

	private startRowFromScrollTop(scrollTop: number) {
		const viewportRows = this.getViewportRows();
		const scrollRangePx = Math.max(
			1,
			this.virtualPanelHeightPx - this.viewportHeight,
		);
		const percent = Math.max(0, Math.min(1, scrollTop / scrollRangePx));
		return this.clampStartRow(percent * this.getScrollableRows(viewportRows));
	}

	private scrollTopFromStartRow(startRow: number) {
		const viewportRows = this.getViewportRows();
		const scrollableRows = this.getScrollableRows(viewportRows);
		const scrollRangePx = Math.max(
			1,
			this.virtualPanelHeightPx - this.viewportHeight,
		);
		const percent =
			scrollableRows <= 0 ? 0 : Math.max(0, Math.min(1, startRow / scrollableRows));
		return percent * scrollRangePx;
	}

	private createDomTree() {
		const tableNode = document.createElement("div");
		tableNode.className = "memory-view-table";

		const headerNode = document.createElement("div");
		headerNode.className = "memory-view-table__header";
		for (const column of this.adapter.columns) {
			const span = document.createElement("span");
			span.textContent = column.title;
			headerNode.append(span);
		}

		const viewportNode = document.createElement("div");
		viewportNode.className = "memory-view-table__viewport";

		const virtualPanelNode = document.createElement("div");
		virtualPanelNode.className = "memory-view-table__virtual-panel";

		const clipNode = document.createElement("div");
		clipNode.className = "memory-view-table__clip";

		const rowsNode = document.createElement("div");
		rowsNode.className = "memory-view-table__rows";
		clipNode.append(rowsNode);
		viewportNode.append(virtualPanelNode, clipNode);
		tableNode.append(headerNode, viewportNode);

		return {
			tableNode,
			viewportNode,
			virtualPanelNode,
			rowsNode,
		};
	}

	private computeViewportWindow(): ViewportWindow {
		const viewportRows = this.getViewportRows();
		this.logicalStartRow = this.clampStartRow(this.logicalStartRow, viewportRows);
		const startRowFloat = this.logicalStartRow;
		const baseRow = Math.floor(startRowFloat);
		const renderStart = Math.max(0, baseRow - this.overscanRows);
		const renderCount = Math.ceil(viewportRows) + this.overscanRows * 2 + 2;
		const renderEnd = Math.min(this.rowCount, renderStart + renderCount);
		return {
			renderStart,
			renderEnd,
			rowsOffsetPx: (renderStart - startRowFloat) * this.rowHeightPx,
			viewportRows,
		};
	}

	private ensureRowPool(size: number) {
		while (this.rowPool.length < size) {
			const row = document.createElement("div");
			row.className = "memory-view-table__row";
			const cells: VirtualListingCellDom[] = [];
			for (const column of this.adapter.columns) {
				const cell = document.createElement("div");
				cell.className = column.cellClassName
					? `memory-view-table__cell ${column.cellClassName}`
					: "memory-view-table__cell";
				const code = document.createElement("code");
				cell.append(code);
				row.append(cell);
				cells.push({ cell, code });
			}

			const state = this.adapter.createRowState(cells);
			this.rowsNode.append(row);
			this.rowPool.push({
				element: row,
				state,
			});
		}
	}

	private fillVisibleRows(renderStart: number, renderEnd: number) {
		const visibleCount = renderEnd - renderStart;
		this.ensureRowPool(visibleCount);
		for (let i = 0; i < this.rowPool.length; i++) {
			const rowDom = this.rowPool[i];
			if (i >= visibleCount) {
				rowDom.element.hidden = true;
				continue;
			}

			const rowIndex = renderStart + i;
			rowDom.element.hidden = false;
			const extraRowClass = this.adapter.getRowClassName?.(rowIndex, rowDom.state);
			rowDom.element.className = extraRowClass
				? `memory-view-table__row ${extraRowClass}`
				: "memory-view-table__row";
			this.adapter.renderRow(rowIndex, rowDom.state);
		}
	}

	private render() {
		if (this.isDisposed) {
			return;
		}

		this.viewportHeight =
			this.viewportNode.clientHeight || this.defaultViewportHeightPx;
		this.virtualPanelNode.style.height = `${this.virtualPanelHeightPx}px`;

		if (this.rowCount === 0) {
			this.logicalStartRow = 0;
			this.scrollTop = 0;
			this.rowsNode.style.transform = "translateY(0px)";
			for (const row of this.rowPool) {
				row.element.hidden = true;
			}
			return;
		}

		const window = this.computeViewportWindow();
		this.rowsNode.style.transform = `translateY(${window.rowsOffsetPx}px)`;

		if (
			!this.forceRowsRefresh &&
			this.visibleStart === window.renderStart &&
			this.visibleEnd === window.renderEnd
		) {
			return;
		}

		this.fillVisibleRows(window.renderStart, window.renderEnd);
		this.visibleStart = window.renderStart;
		this.visibleEnd = window.renderEnd;
		this.forceRowsRefresh = false;
	}
}

export class VanillaMemoryView {
	private readonly panelId: string;
	private readonly panelIndex: number;
	private dumpInfo: ParsedDumpInfo;
	private ranges: ParsedDumpInfo["memoryRanges"] = [];
	private span: MemorySpan | null = null;
	private totalRows = 0;
	private followInstructionPointer = true;
	private manualAddress: bigint | null = null;
	private addressError = "";
	private lastFollowAddress: bigint | null = null;
	private rangeHint = -1;
	private isDisposed = false;

	private readonly root: HTMLElement;
	private readonly addressInput: HTMLInputElement;
	private readonly jumpButton: HTMLButtonElement;
	private readonly followCheckbox: HTMLInputElement;
	private readonly errorNode: HTMLParagraphElement;
	private readonly emptyNode: HTMLParagraphElement;
	private readonly tableNode: HTMLDivElement;
	private readonly table: FixedRowVirtualTable<MemoryRowState>;

	private readonly onFollowChange = () => {
		const next = this.followCheckbox.checked;
		this.followInstructionPointer = next;
		if (next) {
			const ip = this.instructionPointer();
			if (ip !== null) {
				this.jumpToAddress(ip, true);
			}
		}
		this.syncControlState();
		this.saveState();
		this.requestRender(false);
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

		this.jumpToAddress(parsed, false);
	};

	constructor(options: MemoryViewPanelOptions) {
		this.panelId = options.panelId;
		this.panelIndex = parsePanelIndex(options.panelId);
		this.dumpInfo = options.dumpInfo;
		this.root = this.createRoot();
		this.table = new FixedRowVirtualTable<MemoryRowState>({
			adapter: this.createMemoryAdapter(),
			rowHeightPx: ROW_HEIGHT_PX,
			overscanRows: OVERSCAN_ROWS,
			defaultViewportHeightPx: DEFAULT_VIEWPORT_HEIGHT_PX,
			wheelRowsPerTick: WHEEL_ROWS_PER_TICK,
		});
		const dom = this.createDomTree(this.table.element);
		this.addressInput = dom.addressInput;
		this.jumpButton = dom.jumpButton;
		this.followCheckbox = dom.followCheckbox;
		this.errorNode = dom.errorNode;
		this.emptyNode = dom.emptyNode;
		this.tableNode = dom.tableNode;
		options.container.replaceChildren(this.root);

		this.root.addEventListener("submit", this.onAddressSubmit);
		this.followCheckbox.addEventListener("change", this.onFollowChange);

		this.restoreState();
		this.recomputeRangeState();
		this.ensureAddressState();
		this.maybeFollowInstructionPointer();
		this.syncControlState();
		this.requestRender(true);
	}

	update(nextDumpInfo: ParsedDumpInfo) {
		if (this.isDisposed) {
			return;
		}

		this.dumpInfo = nextDumpInfo;
		this.recomputeRangeState();
		this.ensureAddressState();
		this.maybeFollowInstructionPointer();
		this.syncControlState();
		this.requestRender(true);
	}

	dispose() {
		if (this.isDisposed) {
			return;
		}

		this.isDisposed = true;
		this.root.removeEventListener("submit", this.onAddressSubmit);
		this.followCheckbox.removeEventListener("change", this.onFollowChange);
		this.table.dispose();
		this.root.replaceChildren();
	}

	private createMemoryAdapter(): VirtualListingAdapter<MemoryRowState> {
		return {
			columns: [
				{
					title: "Address",
					cellClassName: "memory-view-table__cell--address",
				},
				{
					title: "16 Bytes (Hex)",
					cellClassName: "memory-view-table__cell--hex",
				},
				{
					title: "ASCII",
					cellClassName: "memory-view-table__cell--ascii",
				},
			],
			gridTemplateColumns: "18ch 48ch 16ch",
			createRowState: (cells) => ({
				addressCode: cells[0].code,
				hexCode: cells[1].code,
				asciiCode: cells[2].code,
				hexParts: new Array(BYTES_PER_ROW),
				asciiParts: new Array(BYTES_PER_ROW),
			}),
			renderRow: (rowIndex, rowState) => {
				this.fillRow(rowState, rowIndex);
			},
		};
	}

	private createRoot() {
		const root = document.createElement("section");
		root.className = "memory-view-panel";
		root.setAttribute("aria-label", `Memory view ${this.panelIndex}`);
		return root;
	}

	private createDomTree(tableNode: HTMLDivElement) {
		const toolbar = document.createElement("div");
		toolbar.className = "memory-view-panel__toolbar";

		const jumpForm = document.createElement("form");
		jumpForm.className = "memory-view-panel__jump";

		const jumpLabel = document.createElement("label");
		jumpLabel.className = "memory-view-panel__label";
		jumpLabel.htmlFor = `memory-jump-${this.panelId}`;
		jumpLabel.textContent = "Address";

		const addressInput = document.createElement("input");
		addressInput.id = `memory-jump-${this.panelId}`;
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

		const errorNode = document.createElement("p");
		errorNode.className = "memory-view-panel__error";
		errorNode.hidden = true;

		const emptyNode = document.createElement("p");
		emptyNode.className = "memory-view-panel__empty";
		emptyNode.textContent = "No memory ranges available.";
		emptyNode.hidden = true;

		this.root.append(toolbar, errorNode, emptyNode, tableNode);
		return {
			addressInput,
			jumpButton,
			followCheckbox,
			errorNode,
			emptyNode,
			tableNode,
		};
	}

	private recomputeRangeState() {
		this.ranges = this.dumpInfo.memoryRanges ?? [];
		if (this.ranges.length === 0) {
			this.span = null;
			this.totalRows = 0;
			this.rangeHint = -1;
			this.table.setRowCount(0);
			return;
		}

		let minAddress = this.ranges[0].address;
		let maxAddress = this.ranges[0].address + this.ranges[0].dataSize;
		for (const range of this.ranges) {
			if (range.address < minAddress) {
				minAddress = range.address;
			}
			const rangeEnd = range.address + range.dataSize;
			if (rangeEnd > maxAddress) {
				maxAddress = rangeEnd;
			}
		}

		this.span = {
			start: minAddress,
			endExclusive: maxAddress,
		};

		const spanSize = maxAddress - minAddress;
		const rowsBig =
			(spanSize + BigInt(BYTES_PER_ROW) - 1n) / BigInt(BYTES_PER_ROW);
		const maxRows = BigInt(Number.MAX_SAFE_INTEGER);
		this.totalRows = Number(rowsBig > maxRows ? maxRows : rowsBig);
		this.rangeHint = -1;
		this.table.setRowCount(this.totalRows);
	}

	private ensureAddressState() {
		const span = this.span;
		if (!span) {
			this.manualAddress = null;
			this.addressInput.value = "";
			return;
		}

		if (this.manualAddress === null || !isInSpan(this.manualAddress, span)) {
			this.manualAddress = span.start;
		}

		this.syncInputWithAddress(this.manualAddress);
	}

	private instructionPointer() {
		return this.dumpInfo.debugView?.instructionPointer ?? null;
	}

	private maybeFollowInstructionPointer() {
		if (!this.followInstructionPointer) {
			return;
		}

		const ip = this.instructionPointer();
		if (ip === null || ip === this.lastFollowAddress) {
			return;
		}

		this.lastFollowAddress = ip;
		this.jumpToAddress(ip, true);
	}

	private restoreState() {
		const storageKey = getPanelStorageKey(this.panelId);
		try {
			const raw = window.localStorage.getItem(storageKey);
			if (!raw) {
				return;
			}

			const saved = JSON.parse(raw) as MemoryPanelSavedState;
			if (typeof saved.followInstructionPointer === "boolean") {
				this.followInstructionPointer = saved.followInstructionPointer;
			}

			if (saved.manualAddressHex) {
				const parsed = parseHexAddress(saved.manualAddressHex);
				if (parsed !== null) {
					this.manualAddress = parsed;
				}
			}
		} catch {
			// Ignore persisted-state errors to keep interactions responsive.
		}
	}

	private saveState() {
		const storageKey = getPanelStorageKey(this.panelId);
		const state: MemoryPanelSavedState = {
			manualAddressHex:
				this.manualAddress !== null
					? `0x${this.manualAddress.toString(16)}`
					: "",
			followInstructionPointer: this.followInstructionPointer,
		};

		try {
			window.localStorage.setItem(storageKey, JSON.stringify(state));
		} catch {
			// Ignore storage errors to keep panel usable.
		}
	}

	private syncInputWithAddress(address: bigint | null) {
		if (address === null) {
			this.addressInput.value = "";
			return;
		}

		this.addressInput.value = `0x${fmtAddress(address)}`;
	}

	private syncControlState() {
		const hasSpan = this.span !== null;
		this.followCheckbox.checked = this.followInstructionPointer;
		this.addressInput.disabled = this.followInstructionPointer || !hasSpan;
		this.jumpButton.disabled = this.followInstructionPointer || !hasSpan;
		this.errorNode.hidden = this.addressError.length === 0;
		this.errorNode.textContent = this.addressError;
		this.emptyNode.hidden = hasSpan;
		this.tableNode.hidden = !hasSpan;
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

	private jumpToAddress(address: bigint, keepFollow: boolean) {
		const span = this.span;
		if (!span) {
			return;
		}

		const aligned = alignDownToRow(
			clampAddressToSpan(address, span),
			span.start,
		);
		this.manualAddress = aligned;
		this.syncInputWithAddress(aligned);
		this.clearAddressError();

		if (!keepFollow) {
			this.followInstructionPointer = false;
		}

		this.followCheckbox.checked = this.followInstructionPointer;
		this.syncControlState();
		this.saveState();

		const rowOffsetBig = (aligned - span.start) / BigInt(BYTES_PER_ROW);
		const rowOffset = Number(
			rowOffsetBig > BigInt(Number.MAX_SAFE_INTEGER)
				? BigInt(Number.MAX_SAFE_INTEGER)
				: rowOffsetBig,
		);
		this.scrollToRow(rowOffset);
	}

	private scrollToRow(rowOffset: number) {
		this.table.scrollToRow(rowOffset);
	}

	private requestRender(forceRows: boolean) {
		this.table.requestRender(forceRows);
	}

	private fillRow(row: MemoryRowState, rowIndex: number) {
		const span = this.span;
		if (!span) {
			return;
		}

		const rowAddress = span.start + BigInt(rowIndex) * BigInt(BYTES_PER_ROW);
		const rowEnd = rowAddress + BigInt(BYTES_PER_ROW);
		let out = 0;
		let rangeHint = this.rangeHint;

		while (out < BYTES_PER_ROW) {
			const address = rowAddress + BigInt(out);
			if (!isInSpan(address, span)) {
				row.hexParts[out] = "??";
				row.asciiParts[out] = "?";
				out += 1;
				continue;
			}

			const match = this.dumpInfo.findMemoryRangeAt(
				address,
				rangeHint >= 0 ? rangeHint : undefined,
			);
			if (!match) {
				const nextRangeIndex = this.findNextRangeIndex(address, rangeHint);
				const nextRangeStart =
					nextRangeIndex >= 0 && nextRangeIndex < this.ranges.length
						? this.ranges[nextRangeIndex].address
						: rowEnd;
				const gapEnd = minBigInt(rowEnd, nextRangeStart);
				let gap = Number(gapEnd - address);
				if (gap <= 0) {
					gap = 1;
				}

				for (let i = 0; i < gap && out < BYTES_PER_ROW; i++) {
					row.hexParts[out] = "??";
					row.asciiParts[out] = "?";
					out += 1;
				}

				if (nextRangeIndex >= 0) {
					rangeHint = nextRangeIndex;
				}
				continue;
			}

			rangeHint = match.index;
			const rangeEnd = match.range.address + match.range.dataSize;
			const chunkEnd = minBigInt(
				minBigInt(rowEnd, rangeEnd),
				span.endExclusive,
			);
			const chunkSize = Number(chunkEnd - address);
			if (chunkSize <= 0) {
				row.hexParts[out] = "??";
				row.asciiParts[out] = "?";
				out += 1;
				continue;
			}

			const view = this.dumpInfo.readMemoryViewAt(
				address,
				chunkSize,
				match.index,
			);
			if (!view) {
				row.hexParts[out] = "??";
				row.asciiParts[out] = "?";
				out += 1;
				continue;
			}

			rangeHint = view.rangeIndex;
			for (let i = 0; i < view.bytes.length && out < BYTES_PER_ROW; i++) {
				const value = view.bytes[i];
				row.hexParts[out] = fmtByte(value);
				row.asciiParts[out] = toAscii(value);
				out += 1;
			}
		}

		row.addressCode.textContent = fmtAddress(rowAddress);
		row.hexCode.textContent = row.hexParts.join(" ");
		row.asciiCode.textContent = row.asciiParts.join("");
		this.rangeHint = rangeHint;
	}

	private findNextRangeIndex(address: bigint, hintIndex: number): number {
		const ranges = this.ranges;
		if (ranges.length === 0) {
			return -1;
		}

		let low = 0;
		if (hintIndex >= 0 && hintIndex < ranges.length) {
			if (ranges[hintIndex].address >= address) {
				return hintIndex;
			}

			const next = hintIndex + 1;
			if (next < ranges.length && ranges[next].address >= address) {
				return next;
			}
			low = next;
		}

		let high = ranges.length - 1;
		let found = -1;
		while (low <= high) {
			const mid = (low + high) >> 1;
			const rangeAddress = ranges[mid].address;
			if (rangeAddress >= address) {
				found = mid;
				high = mid - 1;
			} else {
				low = mid + 1;
			}
		}
		return found;
	}
}
