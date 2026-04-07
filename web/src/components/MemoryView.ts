import type {
	GroupPanelPartInitParameters,
	IContentRenderer,
} from "dockview-core";
import { AddressToolbar } from "../lib/addressToolbar";
import type { CpuContext } from "../lib/cpu_context";
import type { DebugMemoryRange } from "../lib/debug_interface";
import { DBG } from "../lib/debugState";
import { fmtHex, fmtHex16 } from "../lib/formatting";
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

export class MemoryView implements IContentRenderer {
	element: HTMLElement;
	private readonly contextHandle: SignalHandle<CpuContext | null>;
	private readonly toolbar: AddressToolbar;
	private readonly table: FixedRowVirtualTable<MemoryRowState>;
	private ranges: DebugMemoryRange[] = [];
	private span: MemorySpan | null = null;
	private totalRows = 0;
	private lastFollowAddress: bigint | null = null;
	private isDisposed = false;

	constructor(element: HTMLElement, panelId: string) {
		this.element = element;
		this.element.setAttribute(
			"aria-label",
			`Memory view ${parsePanelIndex(panelId)}`,
		);
		this.element.tabIndex = 0;

		this.toolbar = new AddressToolbar(this.element, {
			panelId,
			storageKey: getPanelStorageKey(panelId),
			defaultSync: false,
			onNavigate: () => this.onToolbarNavigate(),
			emptyMessage: () => "No memory ranges available.",
		});

		this.table = new FixedRowVirtualTable<MemoryRowState>({
			adapter: this.createMemoryAdapter(),
			rowHeightPx: ROW_HEIGHT_PX,
			overscanRows: OVERSCAN_ROWS,
			defaultViewportHeightPx: DEFAULT_VIEWPORT_HEIGHT_PX,
			wheelRowsPerTick: WHEEL_ROWS_PER_TICK,
		});
		this.element.append(this.table.element);

		this.element.addEventListener("keydown", this.toolbar.onKeyDown);

		this.contextHandle = DBG.currentContext.subscribe(() =>
			this.maybeFollowInstructionPointer(),
		);

		this.recomputeRangeState();
		this.ensureAddressState();
		this.maybeFollowInstructionPointer();
		this.toolbar.syncControlState(this.span !== null);
		this.table.requestRender(true);
	}

	init(_: GroupPanelPartInitParameters): void {}

	dispose() {
		if (this.isDisposed) {
			return;
		}

		this.isDisposed = true;
		this.toolbar.dispose();
		this.contextHandle.dispose();
		this.element.removeEventListener("keydown", this.toolbar.onKeyDown);
		this.table.dispose();
		this.element.replaceChildren();
	}

	private onToolbarNavigate(): void {
		const address = this.toolbar.manualAddress;
		if (address === null || !this.span) return;
		this.scrollToAligned(address);
		this.toolbar.syncDisplayedAddress();
		this.toolbar.syncControlState(this.span !== null);
		this.table.requestRender(false);
	}

	private scrollToAligned(address: bigint): void {
		if (!this.span) return;

		const aligned = alignDownToRow(
			clampAddressToSpan(address, this.span),
			this.span.start,
		);
		this.toolbar.manualAddress = aligned;

		const rowOffsetBig = (aligned - this.span.start) / BigInt(BYTES_PER_ROW);
		const rowOffset = Number(
			rowOffsetBig > BigInt(Number.MAX_SAFE_INTEGER)
				? BigInt(Number.MAX_SAFE_INTEGER)
				: rowOffsetBig,
		);
		this.table.scrollToRow(rowOffset);
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
			this.toolbar.manualAddress = null;
			this.toolbar.syncDisplayedAddress();
			return;
		}

		if (
			this.toolbar.manualAddress === null ||
			!isInSpan(this.toolbar.manualAddress, span)
		) {
			this.toolbar.manualAddress = span.start;
		}

		this.toolbar.syncDisplayedAddress();
	}

	private maybeFollowInstructionPointer() {
		if (!this.toolbar.followInstructionPointer) return;

		const ip = DBG.currentContext.state?.ip ?? null;
		if (ip === null || ip === this.lastFollowAddress) return;

		this.lastFollowAddress = ip;
		this.scrollToAligned(ip);
		this.toolbar.syncDisplayedAddress();
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
		row.addressCode.textContent = fmtHex16(rowAddress);
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

		const rowEnd = rowAddress + BigInt(BYTES_PER_ROW);
		const spanStart =
			span.start > rowAddress ? Number(span.start - rowAddress) : 0;
		const spanEnd =
			span.endExclusive < rowEnd
				? Number(span.endExclusive - rowAddress)
				: BYTES_PER_ROW;

		hexParts.fill("??");
		asciiParts.fill("?");

		if (spanStart < spanEnd) {
			const readAddr = rowAddress + BigInt(spanStart);
			const readSize = spanEnd - spanStart;
			try {
				const bytes = await DBG.read(readAddr, readSize, 1);
				for (let i = 0; i < bytes.length; i++) {
					const value = bytes[i];
					hexParts[spanStart + i] = fmtHex(value, 2);
					asciiParts[spanStart + i] = toAscii(value);
				}
			} catch {
				// leave as ??
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
