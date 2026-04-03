import {
	loadAddressPanelState,
	parseHexAddress,
	saveAddressPanelState,
} from "../lib/addressPanelState";
import type { Context } from "../lib/cpu_context";
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

type DisassemblyViewPanelOptions = {
	container: HTMLElement;
	panelId: string;
};

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

export class VanillaDisassemblyView {
	private readonly panelId: string;
	private readonly contextHandle: SignalHandle<Context | null>;
	private listing: DebugDisassemblyListing | null = null;
	private followInstructionPointer = true;
	private manualAddress: bigint | null = null;
	private addressError = "";
	private isLoadingPrevious = false;
	private isLoadingNext = false;
	private isLoadingListing = false;
	private isDisposed = false;
	private reloadToken = 0;

	private readonly root: HTMLElement;
	private readonly addressInput: HTMLInputElement;
	private readonly jumpButton: HTMLButtonElement;
	private readonly followCheckbox: HTMLInputElement;
	private readonly errorNode: HTMLParagraphElement;
	private readonly emptyNode: HTMLParagraphElement;
	private readonly tableNode: HTMLDivElement;
	private readonly table: FixedRowVirtualTable<DisassemblyRowState>;

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

	constructor(options: DisassemblyViewPanelOptions) {
		this.panelId = options.panelId;
		this.root = this.createRoot(options.panelId);
		this.table = new FixedRowVirtualTable<DisassemblyRowState>({
			adapter: this.createDisassemblyAdapter(),
			rowHeightPx: ROW_HEIGHT_PX,
			overscanRows: OVERSCAN_ROWS,
			defaultViewportHeightPx: DEFAULT_VIEWPORT_HEIGHT_PX,
			wheelRowsPerTick: WHEEL_ROWS_PER_TICK,
			onViewportChange: this.onViewportChange,
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
		this.contextHandle = DBG.currentContext.subscribe(() => this.update());

		this.restoreState();
		this.refreshView(true);
	}

	private update() {
		if (this.isDisposed) {
			return;
		}

		this.listing = null;
		this.isLoadingPrevious = false;
		this.isLoadingNext = false;
		this.clearAddressError();
		this.refreshView(true);
	}

	dispose() {
		if (this.isDisposed) {
			return;
		}

		this.isDisposed = true;
		this.contextHandle.dispose();
		this.root.removeEventListener("submit", this.onAddressSubmit);
		this.followCheckbox.removeEventListener("change", this.onFollowChange);
		this.table.dispose();
		this.root.replaceChildren();
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
				const lines = this.lines();
				const line = lines[rowIndex];
				if (!line) return "";
				const current = line.isCurrent ? "dump-disassembly-table__current" : "";
				const boundary =
					line.symbol &&
					rowIndex > 0 &&
					symbolBase(lines[rowIndex - 1]?.symbol) !== symbolBase(line.symbol)
						? "dump-disassembly-table__fn-boundary"
						: "";
				if (current && boundary) return `${current} ${boundary}`;
				return current || boundary;
			},
		};
	}

	private createRoot(panelId: string) {
		const root = document.createElement("section");
		root.className = "memory-view-panel disassembly-view-panel";
		root.setAttribute("aria-label", `Disassembly view ${panelId}`);
		return root;
	}

	private createDomTree(tableNode: HTMLDivElement) {
		const toolbar = document.createElement("div");
		toolbar.className = "memory-view-panel__toolbar";

		const jumpForm = document.createElement("form");
		jumpForm.className = "memory-view-panel__jump";

		const jumpLabel = document.createElement("label");
		jumpLabel.className = "memory-view-panel__label";
		jumpLabel.htmlFor = `disassembly-jump-${this.panelId}`;
		jumpLabel.textContent = "Address";

		const addressInput = document.createElement("input");
		addressInput.id = `disassembly-jump-${this.panelId}`;
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

	private refreshView(reloadListing: boolean) {
		this.syncDisplayedAddress();
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

		const anchorAddress = this.currentAnchor();
		if (anchorAddress === null) {
			this.listing = null;
			this.isLoadingListing = false;
			this.recomputeRows(true);
			this.syncControlState();
			this.requestRender(true);
			return;
		}

		try {
			const nextListing = await buildDisassemblyListing(DBG, anchorAddress);
			if (this.isDisposed || token !== this.reloadToken) {
				return;
			}
			this.listing = nextListing;
		} catch (error) {
			if (this.isDisposed || token !== this.reloadToken) {
				return;
			}
			const message = error instanceof Error ? error.message : String(error);
			this.listing = toDecodeErrorListing(
				`Disassembly loading failed: ${message}`,
				anchorAddress,
			);
		} finally {
			if (this.isDisposed || token !== this.reloadToken) {
				return;
			}
			this.isLoadingListing = false;
			this.recomputeRows(true);
			this.syncControlState();
			this.requestRender(true);
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

	private lines(): readonly DisassemblyLine[] {
		return this.listing?.lines ?? [];
	}

	private firstLoadedAddress() {
		return this.lines()[0]?.address ?? null;
	}

	private lastLoadedEndAddress() {
		const lines = this.lines();
		const lastLine = lines[lines.length - 1];
		if (!lastLine) {
			return null;
		}

		return lastLine.address + BigInt(lastLine.byteLength);
	}

	private recomputeRows(scrollToCurrent: boolean) {
		const lines = this.lines();
		this.table.setRowCount(lines.length);
		if (!scrollToCurrent || lines.length === 0) {
			return;
		}

		const currentIndex =
			this.listing?.anchorLineIndex >= 0
				? this.listing.anchorLineIndex
				: lines.findIndex((line) => line.isCurrent);
		if (currentIndex >= 0) {
			this.table.scrollToRow(Math.max(0, currentIndex - 6));
		}
	}

	private syncControlState() {
		const hasRows = this.lines().length > 0;
		this.followCheckbox.checked = this.followInstructionPointer;
		this.addressInput.disabled = this.followInstructionPointer;
		this.jumpButton.disabled = this.followInstructionPointer;
		this.errorNode.hidden = this.addressError.length === 0;
		this.errorNode.textContent = this.addressError;
		this.emptyNode.hidden = hasRows;
		this.tableNode.hidden = !hasRows;
		if (!hasRows) {
			this.emptyNode.textContent = this.emptyMessage();
		}
	}

	private emptyMessage() {
		if (this.addressError) {
			return this.listing?.message || "No disassembly instructions available.";
		}
		if (this.isLoadingListing) {
			return "Loading disassembly...";
		}
		if (this.listing) {
			return this.listing.message || "No disassembly instructions available.";
		}
		if (!this.followInstructionPointer && this.manualAddress !== null) {
			return "Enter an address that exists in dump memory to view disassembly.";
		}
		if (this.followInstructionPointer && DBG.currentContext.state?.ip == null) {
			return "No instruction pointer available.";
		}
		return "Disassembly view is unavailable for this dump.";
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

	private async maybeLoadPreviousLines() {
		if (this.isDisposed || this.isLoadingPrevious || this.isLoadingNext) {
			return;
		}

		const listing = this.listing;
		const beforeAddress = this.firstLoadedAddress();
		if (!listing || beforeAddress === null || !listing.hasMorePrevious) {
			return;
		}

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
			);
			currentListing.hasMorePrevious = previousLoad.hasMoreBefore;
			if (previousLoad.lines.length === 0) {
				return;
			}

			currentListing.lines.unshift(...previousLoad.lines);
			if (currentListing.anchorLineIndex >= 0) {
				currentListing.anchorLineIndex += previousLoad.lines.length;
			}
			this.table.setRowCount(currentListing.lines.length);
			this.table.shiftViewportRows(previousLoad.lines.length);
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
		if (this.isDisposed || this.isLoadingPrevious || this.isLoadingNext) {
			return;
		}

		const listing = this.listing;
		const startAddress = this.lastLoadedEndAddress();
		if (!listing || startAddress === null || !listing.hasMoreNext) {
			return;
		}

		this.isLoadingNext = true;

		try {
			const currentListing = this.listing;
			if (!currentListing || this.lastLoadedEndAddress() !== startAddress) {
				return;
			}

			const nextLoad = await loadNextDisassemblyLines(DBG, startAddress);
			currentListing.hasMoreNext = nextLoad.hasMoreAfter;
			if (nextLoad.lines.length === 0) {
				return;
			}

			currentListing.lines.push(...nextLoad.lines);
			this.table.setRowCount(currentListing.lines.length);
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

	private readonly navigateToAddress: AddressNavigator = (address: bigint) => {
		this.manualAddress = address;
		this.followInstructionPointer = false;
		this.followCheckbox.checked = false;
		this.clearAddressError();
		this.saveState();
		this.refreshView(true);
	};

	private fillRow(row: DisassemblyRowState, rowIndex: number) {
		const line = this.lines()[rowIndex];
		if (!line) {
			row.addressCode.textContent = "";
			row.addressCode.title = "";
			row.bytesCode.textContent = "";
			row.instructionCode.textContent = "";
			return;
		}

		row.addressCode.textContent = fmtHex16(line.address);
		row.addressCode.title = line.symbol ?? "";
		row.bytesCode.textContent = line.bytesHex;
		renderInstructionLine(row.instructionCode, line, this.navigateToAddress);
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
