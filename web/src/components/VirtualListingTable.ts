const BROWSER_MAX_VIRTUAL_HEIGHT_PX = navigator.userAgent
	.toLowerCase()
	.includes("firefox")
	? 5_000_000
	: 10_000_000;

export type VirtualListingColumnSpec = {
	title: string;
	cellClassName?: string;
};

export type VirtualListingCellDom = {
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

export type VirtualListingViewportState = {
	logicalStartRow: number;
	rowCount: number;
	viewportRows: number;
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
	onViewportChange?: (state: VirtualListingViewportState) => void;
};

export class FixedRowVirtualTable<TRowState> {
	private readonly adapter: VirtualListingAdapter<TRowState>;
	private readonly rowHeightPx: number;
	private readonly overscanRows: number;
	private readonly defaultViewportHeightPx: number;
	private readonly wheelRowsPerTick: number;
	private readonly onViewportChange: (
		state: VirtualListingViewportState,
	) => void;

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
		this.onViewportChange = options.onViewportChange ?? (() => {});
		this.viewportHeight = options.defaultViewportHeightPx;
		const dom = this.createDomTree();
		this.tableNode = dom.tableNode;
		this.viewportNode = dom.viewportNode;
		this.virtualPanelNode = dom.virtualPanelNode;
		this.rowsNode = dom.rowsNode;

		this.setGridTemplateColumns(this.adapter.gridTemplateColumns);
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

	setGridTemplateColumns(template: string) {
		this.tableNode.style.setProperty("--memory-view-grid-template", template);
	}

	getLogicalStartRow() {
		return this.logicalStartRow;
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

	shiftViewportRows(rowDelta: number) {
		if (!Number.isFinite(rowDelta) || rowDelta === 0) {
			return;
		}

		this.logicalStartRow = this.clampStartRow(this.logicalStartRow + rowDelta);
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

	private clampStartRow(
		startRow: number,
		viewportRows = this.getViewportRows(),
	) {
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
			scrollableRows <= 0
				? 0
				: Math.max(0, Math.min(1, startRow / scrollableRows));
		return percent * scrollRangePx;
	}

	private createDomTree() {
		const tableNode = document.createElement("div");
		tableNode.className = "memory-view-table";

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
		tableNode.append(viewportNode);

		return {
			tableNode,
			viewportNode,
			virtualPanelNode,
			rowsNode,
		};
	}

	private computeViewportWindow(): ViewportWindow {
		const viewportRows = this.getViewportRows();
		this.logicalStartRow = this.clampStartRow(
			this.logicalStartRow,
			viewportRows,
		);
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
			rowDom.element.dataset.rowIndex = String(rowIndex);
			const extraRowClass = this.adapter.getRowClassName?.(
				rowIndex,
				rowDom.state,
			);
			rowDom.element.className = extraRowClass
				? `memory-view-table__row ${extraRowClass}`
				: "memory-view-table__row";
			this.adapter.renderRow(rowIndex, rowDom.state);
		}
	}

	private notifyViewportChange(viewportRows: number) {
		this.onViewportChange({
			logicalStartRow: this.logicalStartRow,
			rowCount: this.rowCount,
			viewportRows,
		});
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
			this.notifyViewportChange(this.getViewportRows());
			return;
		}

		const window = this.computeViewportWindow();
		this.rowsNode.style.transform = `translateY(${window.rowsOffsetPx}px)`;
		this.notifyViewportChange(window.viewportRows);

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
