import type {
	DebugCodeViewInfo,
	DebugMemoryRange,
	DebugModule,
	DebugUnloadedModule,
} from "../lib/debug_interface";
import { DBG } from "../lib/debugState";
import type { DumpSection } from "../lib/dumpSections";
import {
	fmtHex,
	fmtHex8,
	fmtHex16,
	fmtOs,
	fmtProductAndSuite,
} from "../lib/formatting";
import {
	getMinidumpStreamTypeName,
	type MinidumpDebugExceptionInfo,
} from "../lib/minidump_debug_interface";

export type VanillaDumpSummaryOptions = {
	container: HTMLElement;
	sections?: readonly DumpSection[];
};

// ─── helpers ──────────────────────────────────────────────────────────────────

const emptyCell = "-";

const formatTimestamp = (timestamp: number): string => {
	if (!timestamp) return "0 (unset)";
	const iso = new Date(timestamp * 1000).toISOString();
	return `${timestamp} (${iso})`;
};

const formatSeconds = (value: number): string => `${value} sec`;
const formatBytes = (value: bigint): string => `${value.toString()} B`;

type MemoryListSummary = {
	rangeCount: number;
	totalBytes: bigint;
	startAddress: bigint;
	endAddressExclusive: bigint;
};

const summarizeMemoryList = (
	ranges: DebugMemoryRange[],
): MemoryListSummary | null => {
	if (ranges.length === 0) return null;
	let totalBytes = 0n;
	let startAddress = ranges[0].address;
	let endAddressExclusive = startAddress + ranges[0].size;
	for (const range of ranges) {
		const rangeEnd = range.address + range.size;
		totalBytes += range.size;
		if (range.address < startAddress) startAddress = range.address;
		if (rangeEnd > endAddressExclusive) endAddressExclusive = rangeEnd;
	}
	return {
		rangeCount: ranges.length,
		totalBytes,
		startAddress,
		endAddressExclusive,
	};
};

const buildCodeViewColumns = (
	cvi: DebugCodeViewInfo | null,
): [string, string, string, string] => {
	if (!cvi) return [emptyCell, emptyCell, emptyCell, emptyCell];
	switch (cvi.format) {
		case "RSDS":
			return ["RSDS", cvi.pdbFileName || emptyCell, cvi.guid, String(cvi.age)];
		case "NB10":
			return [
				"NB10",
				cvi.pdbFileName || emptyCell,
				`${fmtHex(cvi.timestamp, 8)} @ ${fmtHex(cvi.offset, 8)}`,
				String(cvi.age),
			];
		case "unknown":
			return [cvi.signature, emptyCell, fmtHex(cvi.rawSignature, 8), emptyCell];
		case "invalid":
			return ["invalid", cvi.error, emptyCell, emptyCell];
	}
};

const buildModuleRows = (modules: DebugModule[]): string[][] =>
	modules.map((m) => {
		const [cvFormat, cvPdb, cvIdentifier, cvAge] = buildCodeViewColumns(
			m.codeViewInfo,
		);
		return [
			fmtHex16(m.address),
			fmtHex8(m.size),
			fmtHex8(m.checksum),
			fmtHex8(m.timeDateStamp),
			m.path || emptyCell,
			fmtHex8(m.codeViewRecord.size),
			cvFormat,
			cvPdb,
			cvIdentifier,
			cvAge,
			fmtHex8(m.miscRecord.size),
			fmtHex8(m.miscRecord.rva),
		];
	});

const buildUnloadedModuleRows = (modules: DebugUnloadedModule[]): string[][] =>
	modules.map((m) => [
		fmtHex16(m.address),
		fmtHex8(m.size),
		fmtHex8(m.checksum),
		fmtHex8(m.timeDateStamp),
		m.path || emptyCell,
	]);

const buildExceptionParameterRows = (
	exceptionInfo: MinidumpDebugExceptionInfo | null,
): string[][] =>
	(exceptionInfo?.exceptionRecord.exceptionInformation ?? []).map(
		(value, index) => [String(index), fmtHex(value, 16)],
	);

// ─── DOM helpers ──────────────────────────────────────────────────────────────

const mkEl = <K extends keyof HTMLElementTagNameMap>(
	tag: K,
	className?: string,
): HTMLElementTagNameMap[K] => {
	const node = document.createElement(tag);
	if (className) node.className = className;
	return node;
};

const mkRow = (label: string, value: string): HTMLParagraphElement => {
	const p = mkEl("p", "dump-info-panel__item");
	const span = mkEl("span", "text-medium");
	span.textContent = `${label}: `;
	const code = mkEl("code");
	code.textContent = value;
	p.append(span, " ", code);
	return p;
};

const mkRawRow = (value: string): HTMLParagraphElement => {
	const p = mkEl("p", "dump-info-panel__item");
	const code = mkEl("code");
	code.textContent = value;
	p.append(code);
	return p;
};

const mkTable = (
	headers: string[],
	rows: string[][],
	title?: string,
	onRowClick?: (index: number) => void,
	selectedRowIndex?: number,
): HTMLDivElement => {
	const wrap = mkEl("div", "dump-info-panel__table-wrap");

	if (title) {
		const p = mkEl("p", "dump-info-panel__table-title text-medium");
		p.textContent = title;
		wrap.append(p);
	}

	const table = mkEl("table", "dump-info-table");
	const thead = mkEl("thead");
	const headerRow = mkEl("tr");
	for (const h of headers) {
		const th = mkEl("th");
		th.textContent = h;
		headerRow.append(th);
	}
	thead.append(headerRow);
	table.append(thead);

	const tbody = mkEl("tbody");
	if (rows.length === 0) {
		const tr = mkEl("tr");
		const td = mkEl("td");
		td.colSpan = headers.length;
		const code = mkEl("code");
		code.textContent = "none";
		td.append(code);
		tr.append(td);
		tbody.append(tr);
	} else {
		for (let i = 0; i < rows.length; i++) {
			const tr = mkEl("tr");
			if (onRowClick) {
				tr.classList.add("is-clickable");
				const idx = i;
				tr.addEventListener("click", () => onRowClick(idx));
			}
			if (selectedRowIndex === i) {
				tr.classList.add("is-selected");
			}
			for (const cell of rows[i]) {
				const td = mkEl("td");
				const code = mkEl("code");
				code.textContent = cell;
				td.append(code);
				tr.append(td);
			}
			tbody.append(tr);
		}
	}
	table.append(tbody);
	wrap.append(table);
	return wrap;
};

// ─── section builders ─────────────────────────────────────────────────────────

const buildSummarySection = (container: HTMLElement): void => {
	const di = DBG;

	const h2 = mkEl("h2", "dump-info-panel__title m0");
	h2.textContent = "Dump Summary";
	container.append(h2);
	container.append(mkRow("Checksum", fmtHex(di.checksum, 8)));
	container.append(mkRow("Timestamp", formatTimestamp(di.timestamp)));
	container.append(mkRow("Flags", fmtHex(di.flags, 16)));
	container.append(mkRow("Streams", String(di.streamCount)));
	container.append(
		mkRow(
			"Stream Types",
			di.streamTypes.length > 0
				? di.streamTypes.map(getMinidumpStreamTypeName).join(", ")
				: "none",
		),
	);

	if (di.systemInfo) {
		const wrap = mkEl("div", "dump-info-panel__table-wrap");
		wrap.append(mkRawRow(fmtOs(di.systemInfo)));
		wrap.append(mkRawRow(fmtProductAndSuite(di.systemInfo)));
		wrap.append(
			mkRow(
				"CPU Revision",
				`level ${di.systemInfo.processorLevel}, rev ${fmtHex(di.systemInfo.processorRevision, 4)}`,
			),
		);
		if (di.systemInfo.cpu.type === "x86") {
			wrap.append(mkRow("CPU Vendor", di.systemInfo.cpu.vendorId || "unknown"));
		} else {
			wrap.append(
				mkRow(
					"CPU Features",
					`${fmtHex(di.systemInfo.cpu.processorFeatures[0], 16)}, ${fmtHex(di.systemInfo.cpu.processorFeatures[1], 16)}`,
				),
			);
		}
		container.append(wrap);
	}

	if (di.miscInfo) {
		container.append(mkRow("MiscInfo Size", String(di.miscInfo.sizeOfInfo)));
		container.append(mkRow("MiscInfo Flags1", fmtHex(di.miscInfo.flags1, 8)));
		if (di.miscInfo.processId !== null)
			container.append(mkRow("Process ID", String(di.miscInfo.processId)));
		if (di.miscInfo.processCreateTime !== null)
			container.append(
				mkRow(
					"Process Create Time",
					formatTimestamp(di.miscInfo.processCreateTime),
				),
			);
		if (di.miscInfo.processUserTime !== null)
			container.append(
				mkRow("Process User Time", formatSeconds(di.miscInfo.processUserTime)),
			);
		if (di.miscInfo.processKernelTime !== null)
			container.append(
				mkRow(
					"Process Kernel Time",
					formatSeconds(di.miscInfo.processKernelTime),
				),
			);
		if (di.miscInfo.processorMaxMhz !== null)
			container.append(
				mkRow("CPU Max MHz", String(di.miscInfo.processorMaxMhz)),
			);
		if (di.miscInfo.processorCurrentMhz !== null)
			container.append(
				mkRow("CPU Current MHz", String(di.miscInfo.processorCurrentMhz)),
			);
		if (di.miscInfo.processorMhzLimit !== null)
			container.append(
				mkRow("CPU MHz Limit", String(di.miscInfo.processorMhzLimit)),
			);
		if (di.miscInfo.processorMaxIdleState !== null)
			container.append(
				mkRow("CPU Max Idle State", String(di.miscInfo.processorMaxIdleState)),
			);
		if (di.miscInfo.processorCurrentIdleState !== null)
			container.append(
				mkRow(
					"CPU Current Idle State",
					String(di.miscInfo.processorCurrentIdleState),
				),
			);
	}
};

const buildExceptionSection = (container: HTMLElement): void => {
	const ei = DBG.exceptionInfo;
	if (!ei) return;
	container.append(mkRow("Exception Thread ID", String(ei.threadId)));
	container.append(
		mkRow("Exception Code", fmtHex(ei.exceptionRecord.exceptionCode, 8)),
	);
	container.append(
		mkRow("Exception Flags", fmtHex(ei.exceptionRecord.exceptionFlags, 8)),
	);
	container.append(
		mkRow("Exception Address", fmtHex(ei.exceptionRecord.exceptionAddress, 16)),
	);
	container.append(
		mkRow("Exception Record", fmtHex(ei.exceptionRecord.exceptionRecord, 16)),
	);
	container.append(
		mkRow("Exception Parameters", String(ei.exceptionRecord.numberParameters)),
	);
	container.append(
		mkRow(
			"Exception Context",
			`size=${ei.contextLocation.size}, rva=${fmtHex(ei.contextLocation.rva, 8)}`,
		),
	);
	container.append(
		mkTable(["Index", "Value"], buildExceptionParameterRows(ei)),
	);
};

const buildModulesSection = (container: HTMLElement): void => {
	const dm = DBG.dm;
	if (dm.modules.length > 0) {
		container.append(
			mkTable(
				[
					"Base",
					"Size",
					"Checksum",
					"TimeDateStamp",
					"Name",
					"CV Size",
					"CV Format",
					"CV PDB",
					"CV Identifier",
					"CV Age",
					"Misc Size",
					"Misc RVA",
				],
				buildModuleRows(dm.modules),
			),
		);
	}
	if (dm.unloadedModules.length > 0) {
		container.append(
			mkTable(
				["Base", "Size", "Checksum", "TimeDateStamp", "Name"],
				buildUnloadedModuleRows(dm.unloadedModules),
			),
		);
	}
};

const buildMemorySection = (container: HTMLElement): void => {
	const summary = summarizeMemoryList(DBG.dm.memoryRanges ?? []);
	container.append(
		mkRow("Memory Ranges", summary ? String(summary.rangeCount) : "0"),
	);
	container.append(
		mkRow("Memory Bytes", summary ? formatBytes(summary.totalBytes) : "0 B"),
	);
	if (summary) {
		container.append(
			mkRow(
				"Memory Address Span",
				`${fmtHex(summary.startAddress, 16)} to ${fmtHex(summary.endAddressExclusive, 16)} (end exclusive)`,
			),
		);
	}
};

// ─── class ────────────────────────────────────────────────────────────────────

export class VanillaDumpSummary {
	private panel: HTMLElement;

	constructor(options: VanillaDumpSummaryOptions) {
		this.panel = mkEl("section", "dump-info-panel");
		this.panel.setAttribute("aria-label", "Dump details");
		options.container.append(this.panel);

		this.render(options.sections);
	}

	private render(sections: readonly DumpSection[] | undefined): void {
		const hasSection = (s: DumpSection) => sections?.includes(s) ?? true;

		if (hasSection("summary")) buildSummarySection(this.panel);
		if (hasSection("exception") && DBG.exceptionInfo)
			buildExceptionSection(this.panel);
		if (hasSection("modules")) buildModulesSection(this.panel);
		if (hasSection("memory")) buildMemorySection(this.panel);
	}

	dispose(): void {
		this.panel.remove();
	}
}
