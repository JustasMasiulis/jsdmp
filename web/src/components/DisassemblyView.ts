import type {
	GroupPanelPartInitParameters,
	IContentRenderer,
} from "dockview-core";
import { AddressToolbar } from "../lib/addressToolbar";
import type { CpuContext } from "../lib/cpu_context";
import { DBG } from "../lib/debugState";
import {
	buildReachableCfg,
	type CfgInstruction,
	type LinearizedCfgBlock,
	linearizeReachableCfg,
	type ReachableCfgBuildResult,
} from "../lib/disassemblyGraph";
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
} from "./VirtualListingTable";

const ROW_HEIGHT_PX = 20;
const OVERSCAN_ROWS = 10;
const DEFAULT_VIEWPORT_HEIGHT_PX = 320;
const WHEEL_ROWS_PER_TICK = 2;
const DISASSEMBLY_PANEL_STATE_KEY =
	"wasm-dump-debugger:disassembly-panel-state:v1";

type ViewRow =
	| { kind: "block_label"; block: LinearizedCfgBlock; text: string }
	| {
			kind: "instruction";
			block: LinearizedCfgBlock;
			instruction: CfgInstruction;
	  }
	| { kind: "note"; block: LinearizedCfgBlock; text: string };

type DisassemblyRowState = {
	addressCode: HTMLElement;
	bytesCode: HTMLElement;
	instructionCode: HTMLElement;
};

const renderInstructionLine = (
	parent: HTMLElement,
	instruction: Pick<CfgInstruction, "mnemonic" | "operandSegments">,
	onNavigate?: AddressNavigator,
) => {
	parent.textContent = "";
	const mnemonicCol = document.createElement("span");
	mnemonicCol.className = "disasm-mnemonic-col";
	renderSegment(mnemonicCol, {
		text: instruction.mnemonic,
		syntaxKind: "mnemonic",
	});
	parent.appendChild(mnemonicCol);
	if (instruction.operandSegments.length > 0) {
		renderSegments(parent, instruction.operandSegments, onNavigate);
	}
};

const getPanelStorageKey = (panelId: string) =>
	`${DISASSEMBLY_PANEL_STATE_KEY}:${panelId}`;

const makeBlockLabel = (block: LinearizedCfgBlock) => {
	const label = block.block.title || `loc_${fmtHex16(block.block.address)}`;
	if (block.overlapSourceAddresses.length === 0) {
		return `${label}:`;
	}
	const overlapList = block.overlapSourceAddresses
		.map((address) => `0x${fmtHex16(address)}`)
		.join(", ");
	return `${label}: ; overlaps ${overlapList}`;
};

export class DisassemblyView implements IContentRenderer {
	element: HTMLElement;
	private readonly toolbar: AddressToolbar;
	private readonly contextHandle: SignalHandle<CpuContext | null>;
	private cfgResult: ReachableCfgBuildResult | null = null;
	private linearBlocks: LinearizedCfgBlock[] = [];
	private isLoadingListing = false;
	private isDisposed = false;
	private reloadToken = 0;
	private loadErrorMessage: string | null = null;
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

		this.selectedAddress = vr.instruction.address;
		this.toolbar.selectAddress(vr.instruction.address);
		this.requestRender(true);
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
		this.cfgResult = null;
		this.linearBlocks = [];
		this.loadErrorMessage = null;
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

				if (vr.kind === "block_label") {
					const classes = ["dump-disassembly-table__block-label"];
					if (vr.block.overlapSourceAddresses.length > 0) {
						classes.push("dump-disassembly-table__block-label--overlap");
					}
					return classes.join(" ");
				}

				if (vr.kind === "note") {
					return "dump-disassembly-table__note";
				}

				const classes: string[] = [];
				if (vr.instruction.address === this.toolbar.currentAnchor()) {
					classes.push("dump-disassembly-table__current");
				}
				if (vr.instruction.address === this.selectedAddress) {
					classes.push("dump-disassembly-table__selected");
				}
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
		this.isLoadingListing = true;
		this.loadErrorMessage = null;

		const context = DBG.currentContext.state;
		if (!context) {
			this.cfgResult = null;
			this.linearBlocks = [];
			this.isLoadingListing = false;
			this.recomputeRows(true);
			this.syncControlState();
			this.requestRender(true);
			return;
		}

		const anchorAddress = this.toolbar.currentAnchor();
		if (anchorAddress === null) {
			this.cfgResult = null;
			this.linearBlocks = [];
			this.isLoadingListing = false;
			this.recomputeRows(true);
			this.syncControlState();
			this.requestRender(true);
			return;
		}

		try {
			const cfg = await buildReachableCfg(DBG, anchorAddress);
			if (this.isDisposed || token !== this.reloadToken) return;
			this.cfgResult = cfg;
			this.linearBlocks = linearizeReachableCfg(cfg);
		} catch (error) {
			if (this.isDisposed || token !== this.reloadToken) return;
			this.cfgResult = null;
			this.linearBlocks = [];
			this.loadErrorMessage =
				error instanceof Error
					? `Disassembly loading failed: ${error.message}`
					: `Disassembly loading failed: ${String(error)}`;
		} finally {
			if (!this.isDisposed && token === this.reloadToken) {
				this.isLoadingListing = false;
				this.recomputeRows(true);
				this.syncControlState();
				this.requestRender(true);
			}
		}
	}

	private recomputeRows(scrollToAnchor: boolean) {
		this.buildViewRows();
		this.table.setRowCount(this.viewRows.length);
		if (!scrollToAnchor || this.viewRows.length === 0) return;
		if (this.anchorViewIndex >= 0) {
			this.table.scrollToRow(Math.max(0, this.anchorViewIndex - 6));
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
		if (this.loadErrorMessage) {
			return this.loadErrorMessage;
		}
		if (this.cfgResult) {
			return "No reachable instructions available.";
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
			(vr) => vr.kind === "instruction" && vr.instruction.address === address,
		);
		if (idx < 0) return false;
		this.selectedAddress = address;
		this.toolbar.syncDisplayedAddress();
		this.syncControlState();
		this.table.scrollToRow(Math.max(0, idx - 6));
		return true;
	}

	private requestRender(forceRows: boolean) {
		this.table.requestRender(forceRows);
	}

	private buildViewRows() {
		const rows: ViewRow[] = [];
		const anchorAddress = this.toolbar.currentAnchor();
		let anchorViewIndex = -1;

		for (const block of this.linearBlocks) {
			const labelRowIndex = rows.length;
			rows.push({
				kind: "block_label",
				block,
				text: makeBlockLabel(block),
			});
			if (
				anchorViewIndex < 0 &&
				block.block.address === anchorAddress &&
				block.block.instructions.length === 0
			) {
				anchorViewIndex = labelRowIndex;
			}

			for (const instruction of block.block.instructions) {
				if (anchorViewIndex < 0 && instruction.address === anchorAddress) {
					anchorViewIndex = rows.length;
				}
				rows.push({ kind: "instruction", block, instruction });
			}

			if (block.block.error) {
				if (
					anchorViewIndex < 0 &&
					block.block.address === anchorAddress &&
					block.block.instructions.length === 0
				) {
					anchorViewIndex = rows.length;
				}
				rows.push({
					kind: "note",
					block,
					text: block.block.error,
				});
			}
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

		if (vr.kind === "block_label") {
			row.addressCode.textContent = fmtHex16(vr.block.block.address);
			row.addressCode.title = vr.block.block.title;
			row.bytesCode.textContent = "";
			row.instructionCode.textContent = vr.text;
			return;
		}

		if (vr.kind === "note") {
			row.addressCode.textContent = "";
			row.addressCode.title = "";
			row.bytesCode.textContent = "";
			row.instructionCode.textContent = vr.text;
			return;
		}

		row.addressCode.textContent = fmtHex16(vr.instruction.address);
		row.addressCode.title = vr.block.block.title;
		row.bytesCode.textContent = vr.instruction.bytesHex;
		renderInstructionLine(
			row.instructionCode,
			vr.instruction,
			this.navigateToAddress,
		);
	}
}
