import {
	formatHexAddress,
	formatHexAddressValue,
	loadAddressPanelState,
	parseHexAddress,
	saveAddressPanelState,
} from "../lib/addressPanelState";
import type { Context } from "../lib/cpu_context";
import type { DebugMemoryRange } from "../lib/debug_interface";
import { DBG } from "../lib/debugState";
import type { SignalHandle } from "../lib/reactive";
import {
	FixedRowVirtualTable,
	type VirtualListingAdapter,
} from "./VirtualListingTable";

const BYTES_PER_ROW = 16;
const ROW_HEIGHT_PX = 20;
const OVERSCAN_ROWS = 10;
const DEFAULT_VIEWPORT_HEIGHT_PX = 320;
const WHEEL_ROWS_PER_TICK = 2;
const MEMORY_PANEL_STATE_KEY = "wasm-dump-debugger:memory-panel-state:v1";

type MemoryViewPanelOptions = {
	container: HTMLElement;
	panelId: string;
};

type MemorySpan = {
	start: bigint;
	endExclusive: bigint;
};

type MemoryRowState = {
	addressCode: HTMLElement;
	hexCode: HTMLElement;
	asciiCode: HTMLElement;
	hexParts: string[];
	asciiParts: string[];
	renderToken: number;
};

const fmtByte = (value: number) =>
	value.toString(16).toUpperCase().padStart(2, "0");

const toAscii = (value: number) =>
	value >= 0x20 && value <= 0x7e ? String.fromCharCode(value) : ".";

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

export class VanillaMemoryView {
	private readonly panelId: string;
	private readonly panelIndex: number;
	private readonly contextHandle: SignalHandle<Context | null>;
	private ranges: DebugMemoryRange[] = [];
	private span: MemorySpan | null = null;
	private totalRows = 0;
	private followInstructionPointer = true;
	private manualAddress: bigint | null = null;
	private addressError = "";
	private lastFollowAddress: bigint | null = null;
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
		this.contextHandle = DBG.currentContext.subscribe(() =>
			this.maybeFollowInstructionPointer(),
		);

		this.restoreState();
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
		this.contextHandle.dispose();
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
				renderToken: 0,
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
		this.ranges = DBG.memoryRanges.state;
		if (this.ranges.length === 0) {
			this.span = null;
			this.totalRows = 0;
			this.table.setRowCount(0);
			return;
		}

		let minAddress = this.ranges[0].address;
		let maxAddress = this.ranges[0].address + this.ranges[0].size;
		for (const range of this.ranges) {
			if (range.address < minAddress) {
				minAddress = range.address;
			}
			const rangeEnd = range.address + range.size;
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
		return DBG.currentContext.state?.ip ?? null;
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

	private syncInputWithAddress(address: bigint | null) {
		if (address === null) {
			this.addressInput.value = "";
			return;
		}

		this.addressInput.value = formatHexAddress(address);
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
			row.addressCode.textContent = "";
			row.hexCode.textContent = "";
			row.asciiCode.textContent = "";
			return;
		}

		const rowAddress = span.start + BigInt(rowIndex) * BigInt(BYTES_PER_ROW);
		const token = row.renderToken + 1;
		row.renderToken = token;
		row.addressCode.textContent = formatHexAddressValue(rowAddress);
		row.hexCode.textContent = "";
		row.asciiCode.textContent = "";
		void this.fillRowAsync(row, rowAddress, span, token);
	}

	private async fillRowAsync(
		row: MemoryRowState,
		rowAddress: bigint,
		span: MemorySpan,
		token: number,
	) {
		const hexParts = new Array<string>(BYTES_PER_ROW);
		const asciiParts = new Array<string>(BYTES_PER_ROW);

		for (let out = 0; out < BYTES_PER_ROW; out += 1) {
			const address = rowAddress + BigInt(out);
			if (!isInSpan(address, span)) {
				hexParts[out] = "??";
				asciiParts[out] = "?";
				continue;
			}

			try {
				const bytes = await DBG.read(address, 1);
				const value = bytes[0];
				hexParts[out] = fmtByte(value);
				asciiParts[out] = toAscii(value);
			} catch {
				hexParts[out] = "??";
				asciiParts[out] = "?";
			}
		}

		if (this.isDisposed || row.renderToken !== token) {
			return;
		}

		row.hexParts.splice(0, row.hexParts.length, ...hexParts);
		row.asciiParts.splice(0, row.asciiParts.length, ...asciiParts);
		row.hexCode.textContent = hexParts.join(" ");
		row.asciiCode.textContent = asciiParts.join("");
	}
}
