import type {
	GroupPanelPartInitParameters,
	IContentRenderer,
} from "dockview-core";
import { AddressToolbar } from "../lib/addressToolbar";
import type { CpuContext } from "../lib/cpu_context";
import {
	buildDisassemblyListing,
	type DebugDisassemblyListing,
	type DisassemblyLine,
	loadNextDisassemblyLines,
	loadPreviousDisassemblyLines,
} from "../lib/debugDisassembly";
import { DBG } from "../lib/debugState";
import { fmtHex16 } from "../lib/formatting";
import type { SignalHandle } from "../lib/reactive";
import {
	type AddressNavigator,
	renderSegment,
	renderSegments,
} from "../lib/syntaxHighlight";
import {
	FixedRowVirtualTable,
	type VirtualListingAdapter,
	type VirtualListingViewportState,
} from "./VirtualListingTable";

const symbolBase = (sym: string | undefined): string => {
	if (!sym) return "";
	const i = sym.lastIndexOf("+0x");
	return i >= 0 ? sym.slice(0, i) : sym;
};

const ROW_HEIGHT_PX = 20;
const OVERSCAN_ROWS = 10;
const DEFAULT_VIEWPORT_HEIGHT_PX = 320;
const WHEEL_ROWS_PER_TICK = 2;
const BACKWARD_LOAD_THRESHOLD_ROWS = 8;
const FORWARD_LOAD_THRESHOLD_ROWS = 4;
const DISASSEMBLY_PANEL_STATE_KEY =
	"wasm-dump-debugger:disassembly-panel-state:v1";

type ViewRow =
	| { kind: "instruction"; line: DisassemblyLine; lineIndex: number }
	| { kind: "label"; text: string };

type DisassemblyRowState = {
	addressCode: HTMLElement;
	bytesCode: HTMLElement;
	instructionCode: HTMLElement;
};

const renderInstructionLine = (
	parent: HTMLElement,
	line: DisassemblyLine,
	onNavigate?: AddressNavigator,
) => {
	parent.textContent = "";
	const mnemonicCol = document.createElement("span");
	mnemonicCol.className = "disasm-mnemonic-col";
	renderSegment(mnemonicCol, { text: line.mnemonic, syntaxKind: "mnemonic" });
	parent.appendChild(mnemonicCol);
	if (line.operandSegments.length > 0) {
		renderSegments(parent, line.operandSegments, onNavigate);
	}
};

const getPanelStorageKey = (panelId: string) =>
	`${DISASSEMBLY_PANEL_STATE_KEY}:${panelId}`;

const toDecodeErrorListing = (
	message: string,
	anchorAddress: bigint | null,
): DebugDisassemblyListing => ({
	status: "decode_error",
	message,
	anchorAddress,
	anchorLineIndex: -1,
	hasMorePrevious: false,
	hasMoreNext: false,
	lines: [],
});

export class DisassemblyView implements IContentRenderer {
	element: HTMLElement;
	private readonly toolbar: AddressToolbar;
	private readonly contextHandle: SignalHandle<CpuContext | null>;
	private listing: DebugDisassemblyListing | null = null;
	private isLoadingPrevious = false;
	private isLoadingNext = false;
	private isLoadingListing = false;
	private isDisposed = false;
	private reloadToken = 0;
	private viewRows: ViewRow[] = [];
	private anchorViewIndex = -1;
	private selectedAddress: bigint | null = null;

	private readonly tableNode: HTMLDivElement;
	private readonly table: FixedRowVirtualTable<DisassemblyRowState>;
	private readonly navigateToAddress = (addr: bigint) =>
		this.toolbar.navigateToAddress(addr);

	private readonly onRowClick = (event: MouseEvent) => {
		const row = (event.target as HTMLElement).closest<HTMLElement>(
			".memory-view-table__row[data-row-index]",
		);
		if (!row) return;

		const rowIndex = Number.parseInt(row.dataset.rowIndex ?? "", 10);
		if (Number.isNaN(rowIndex)) return;
		const vr = this.viewRows[rowIndex];
		if (!vr || vr.kind !== "instruction") return;

		this.selectedAddress = vr.line.address;
		this.toolbar.selectAddress(vr.line.address);
		this.requestRender(true);
	};

	private readonly onViewportChange = (
		viewport: VirtualListingViewportState,
	) => {
		if (viewport.logicalStartRow <= BACKWARD_LOAD_THRESHOLD_ROWS) {
			this.maybeLoadPreviousLines();
		}

		if (
			viewport.logicalStartRow + viewport.viewportRows >=
			viewport.rowCount - FORWARD_LOAD_THRESHOLD_ROWS
		) {
			this.maybeLoadNextLines();
		}
	};

	constructor(element: HTMLElement, panelId: string) {
		this.element = element;
		this.element.setAttribute("aria-label", `Disassembly view ${panelId}`);

		this.toolbar = new AddressToolbar(this.element, {
			panelId,
			storageKey: getPanelStorageKey(panelId),
			defaultSync: true,
			onNavigate: () => this.refreshView(true),
			onFocusAddress: (addr) => this.focusAddress(addr),
			emptyMessage: () => this.emptyMessage(),
		});

		this.table = new FixedRowVirtualTable<DisassemblyRowState>({
			adapter: this.createDisassemblyAdapter(),
			rowHeightPx: ROW_HEIGHT_PX,
			overscanRows: OVERSCAN_ROWS,
			defaultViewportHeightPx: DEFAULT_VIEWPORT_HEIGHT_PX,
			wheelRowsPerTick: WHEEL_ROWS_PER_TICK,
			onViewportChange: this.onViewportChange,
		});
		this.tableNode = this.table.element;
		this.element.appendChild(this.tableNode);

		this.element.tabIndex = 0;
		this.element.addEventListener("keydown", this.toolbar.onKeyDown);
		this.tableNode.addEventListener("click", this.onRowClick);

		this.contextHandle = DBG.currentContext.subscribe(() =>
			this.onContextChanged(),
		);

		this.refreshView(true);
	}

	init(_: GroupPanelPartInitParameters): void {}

	private onContextChanged() {
		if (this.isDisposed) return;

		this.selectedAddress = null;
		this.listing = null;
		this.isLoadingPrevious = false;
		this.isLoadingNext = false;
		this.refreshView(true);
	}

	dispose() {
		if (this.isDisposed) return;

		this.isDisposed = true;
		this.contextHandle.dispose();
		this.element.removeEventListener("keydown", this.toolbar.onKeyDown);
		this.tableNode.removeEventListener("click", this.onRowClick);
		this.toolbar.dispose();
		this.table.dispose();
		this.element.replaceChildren();
	}

	private createDisassemblyAdapter(): VirtualListingAdapter<DisassemblyRowState> {
		return {
			columns: [
				{
					title: "Address",
					cellClassName: "memory-view-table__cell--address",
				},
				{
					title: "Bytes",
					cellClassName: "memory-view-table__cell--hex",
				},
				{
					title: "Disassembled instruction",
					cellClassName: "memory-view-table__cell--instruction",
				},
			],
			gridTemplateColumns: "18ch 34ch minmax(36ch, 1fr)",
			createRowState: (cells) => ({
				addressCode: cells[0].code,
				bytesCode: cells[1].code,
				instructionCode: cells[2].code,
			}),
			renderRow: (rowIndex, rowState) => {
				this.fillRow(rowState, rowIndex);
			},
			getRowClassName: (rowIndex) => {
				const vr = this.viewRows[rowIndex];
				if (!vr) return "";
				if (vr.kind === "label") return "dump-disassembly-table__fn-label";
				const classes: string[] = [];
				if (vr.line.isCurrent) classes.push("dump-disassembly-table__current");
				if (vr.line.address === this.selectedAddress)
					classes.push("dump-disassembly-table__selected");
				return classes.join(" ");
			},
		};
	}

	private refreshView(reloadListing: boolean) {
		this.toolbar.syncDisplayedAddress();
		if (reloadListing) {
			void this.reloadListing();
			return;
		}
		this.recomputeRows(true);
		this.syncControlState();
		this.requestRender(true);
	}

	private async reloadListing() {
		const token = ++this.reloadToken;
		this.isLoadingPrevious = false;
		this.isLoadingNext = false;
		this.isLoadingListing = true;

		const context = DBG.currentContext.state;
		if (!context) {
			this.listing = null;
			this.isLoadingListing = false;
			this.recomputeRows(true);
			this.syncControlState();
			this.requestRender(true);
			return;
		}

		const anchorAddress = this.toolbar.currentAnchor();
		if (anchorAddress === null) {
			this.listing = null;
			this.isLoadingListing = false;
			this.recomputeRows(true);
			this.syncControlState();
			this.requestRender(true);
			return;
		}

		try {
			const nextListing = await buildDisassemblyListing(
				DBG,
				anchorAddress,
				DBG.arch,
			);
			if (this.isDisposed || token !== this.reloadToken) return;
			this.listing = nextListing;
		} catch (error) {
			if (this.isDisposed || token !== this.reloadToken) return;
			const message = error instanceof Error ? error.message : String(error);
			this.listing = toDecodeErrorListing(
				`Disassembly loading failed: ${message}`,
				anchorAddress,
			);
		} finally {
			if (!this.isDisposed && token === this.reloadToken) {
				this.isLoadingListing = false;
				this.recomputeRows(true);
				this.syncControlState();
				this.requestRender(true);
			}
		}
	}

	private lines(): readonly DisassemblyLine[] {
		return this.listing?.lines ?? [];
	}

	private firstLoadedAddress() {
		return this.lines()[0]?.address ?? null;
	}

	private lastLoadedEndAddress() {
		const lines = this.lines();
		const lastLine = lines[lines.length - 1];
		if (!lastLine) return null;
		return lastLine.address + BigInt(lastLine.byteLength);
	}

	private recomputeRows(scrollToCurrent: boolean) {
		this.buildViewRows();
		this.table.setRowCount(this.viewRows.length);
		if (!scrollToCurrent || this.viewRows.length === 0) return;

		let scrollTarget = this.anchorViewIndex;
		if (scrollTarget < 0) {
			scrollTarget = this.viewRows.findIndex(
				(vr) => vr.kind === "instruction" && vr.line.isCurrent,
			);
		}
		if (scrollTarget >= 0) {
			this.table.scrollToRow(Math.max(0, scrollTarget - 6));
		}
	}

	private syncControlState() {
		const hasRows = this.viewRows.length > 0;
		this.toolbar.syncControlState(hasRows);
		this.tableNode.hidden = !hasRows;
	}

	private emptyMessage() {
		if (this.isLoadingListing) {
			return "Loading disassembly...";
		}
		if (this.listing) {
			return this.listing.message || "No disassembly instructions available.";
		}
		if (
			!this.toolbar.followInstructionPointer &&
			this.toolbar.manualAddress !== null
		) {
			return "Enter an address that exists in dump memory to view disassembly.";
		}
		if (
			this.toolbar.followInstructionPointer &&
			DBG.currentContext.state?.ip == null
		) {
			return "No instruction pointer available.";
		}
		return "Disassembly view is unavailable for this dump.";
	}

	private focusAddress(address: bigint): boolean {
		const idx = this.viewRows.findIndex(
			(vr) => vr.kind === "instruction" && vr.line.address === address,
		);
		if (idx < 0) return false;
		this.selectedAddress = address;
		this.toolbar.syncDisplayedAddress();
		this.syncControlState();
		this.table.scrollToRow(Math.max(0, idx - 6));
		return true;
	}

	private async maybeLoadPreviousLines() {
		if (this.isDisposed || this.isLoadingPrevious || this.isLoadingNext) return;

		const listing = this.listing;
		const beforeAddress = this.firstLoadedAddress();
		if (!listing || beforeAddress === null || !listing.hasMorePrevious) return;

		this.isLoadingPrevious = true;

		try {
			const currentListing = this.listing;
			if (
				!currentListing ||
				currentListing.lines.length === 0 ||
				currentListing.lines[0]?.address !== beforeAddress
			) {
				return;
			}

			const previousLoad = await loadPreviousDisassemblyLines(
				DBG,
				beforeAddress,
				DBG.arch,
			);
			currentListing.hasMorePrevious = previousLoad.hasMoreBefore;
			if (previousLoad.lines.length === 0) return;

			currentListing.lines.unshift(...previousLoad.lines);
			if (currentListing.anchorLineIndex >= 0) {
				currentListing.anchorLineIndex += previousLoad.lines.length;
			}
			const prevViewCount = this.viewRows.length;
			this.buildViewRows();
			const viewDelta = this.viewRows.length - prevViewCount;
			this.table.setRowCount(this.viewRows.length);
			this.table.shiftViewportRows(viewDelta);
		} catch {
			const currentListing = this.listing;
			if (currentListing) {
				currentListing.hasMorePrevious = false;
			}
		} finally {
			if (!this.isDisposed) {
				this.isLoadingPrevious = false;
			}
		}
	}

	private async maybeLoadNextLines() {
		if (this.isDisposed || this.isLoadingPrevious || this.isLoadingNext) return;

		const listing = this.listing;
		const startAddress = this.lastLoadedEndAddress();
		if (!listing || startAddress === null || !listing.hasMoreNext) return;

		this.isLoadingNext = true;

		try {
			const currentListing = this.listing;
			if (!currentListing || this.lastLoadedEndAddress() !== startAddress)
				return;

			const nextLoad = await loadNextDisassemblyLines(
				DBG,
				startAddress,
				DBG.arch,
			);
			currentListing.hasMoreNext = nextLoad.hasMoreAfter;
			if (nextLoad.lines.length === 0) return;

			currentListing.lines.push(...nextLoad.lines);
			this.buildViewRows();
			this.table.setRowCount(this.viewRows.length);
			this.requestRender(true);
		} catch {
			const currentListing = this.listing;
			if (currentListing) {
				currentListing.hasMoreNext = false;
			}
		} finally {
			if (!this.isDisposed) {
				this.isLoadingNext = false;
			}
		}
	}

	private requestRender(forceRows: boolean) {
		this.table.requestRender(forceRows);
	}

	private buildViewRows() {
		const lines = this.lines();
		const rows: ViewRow[] = [];
		const anchorLineIndex = this.listing?.anchorLineIndex ?? -1;
		let anchorViewIndex = -1;
		let prevSymBase = "";

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			const curSymBase = symbolBase(line.symbol);
			if (curSymBase && curSymBase !== prevSymBase) {
				rows.push({ kind: "label", text: curSymBase + ":" });
			}
			if (i === anchorLineIndex) {
				anchorViewIndex = rows.length;
			}
			rows.push({ kind: "instruction", line, lineIndex: i });
			prevSymBase = curSymBase;
		}

		this.viewRows = rows;
		this.anchorViewIndex = anchorViewIndex;
	}

	private fillRow(row: DisassemblyRowState, rowIndex: number) {
		const vr = this.viewRows[rowIndex];
		if (!vr) {
			row.addressCode.textContent = "";
			row.addressCode.title = "";
			row.bytesCode.textContent = "";
			row.instructionCode.textContent = "";
			return;
		}

		if (vr.kind === "label") {
			row.addressCode.textContent = vr.text;
			row.addressCode.title = "";
			row.bytesCode.textContent = "";
			row.instructionCode.textContent = "";
			return;
		}

		const line = vr.line;
		row.addressCode.textContent = fmtHex16(line.address);
		row.addressCode.title = line.symbol ?? "";
		row.bytesCode.textContent = line.bytesHex;
		renderInstructionLine(row.instructionCode, line, this.navigateToAddress);
	}
}
