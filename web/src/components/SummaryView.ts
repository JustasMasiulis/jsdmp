import type {
	GroupPanelPartInitParameters,
	IContentRenderer,
} from "dockview-core";
import { html, render } from "lit-html";
import { DBG } from "../lib/debugState";
import { fmtHex, fmtOs, fmtProductAndSuite } from "../lib/formatting";
import { getMinidumpStreamTypeName } from "../lib/minidump_debug_interface";
import { labeledRow, rawRow } from "../lib/templates";

const formatTimestamp = (timestamp: number): string => {
	if (!timestamp) return "0 (unset)";
	const iso = new Date(timestamp * 1000).toISOString();
	return `${timestamp} (${iso})`;
};

const formatSeconds = (value: number): string => `${value} sec`;

const systemInfoTemplate = () => {
	const si = DBG.systemInfo;
	if (!si) return "";

	const cpuRow =
		si.cpu.type === "x86"
			? labeledRow("CPU Vendor", si.cpu.vendorId || "unknown")
			: labeledRow(
					"CPU Features",
					`${fmtHex(si.cpu.processorFeatures[0], 16)}, ${fmtHex(si.cpu.processorFeatures[1], 16)}`,
				);

	return html`
		<div class="dump-info-panel__table-wrap">
			${rawRow(fmtOs(si))}
			${rawRow(fmtProductAndSuite(si))}
			${labeledRow("CPU Revision", `level ${si.processorLevel}, rev ${fmtHex(si.processorRevision, 4)}`)}
			${cpuRow}
		</div>
	`;
};

const miscInfoTemplate = () => {
	const mi = DBG.miscInfo;
	if (!mi) return "";

	return html`
		${labeledRow("MiscInfo Size", String(mi.sizeOfInfo))}
		${labeledRow("MiscInfo Flags1", fmtHex(mi.flags1, 8))}
		${mi.processId !== null ? labeledRow("Process ID", String(mi.processId)) : ""}
		${mi.processCreateTime !== null ? labeledRow("Process Create Time", formatTimestamp(mi.processCreateTime)) : ""}
		${mi.processUserTime !== null ? labeledRow("Process User Time", formatSeconds(mi.processUserTime)) : ""}
		${mi.processKernelTime !== null ? labeledRow("Process Kernel Time", formatSeconds(mi.processKernelTime)) : ""}
		${mi.processorMaxMhz !== null ? labeledRow("CPU Max MHz", String(mi.processorMaxMhz)) : ""}
		${mi.processorCurrentMhz !== null ? labeledRow("CPU Current MHz", String(mi.processorCurrentMhz)) : ""}
		${mi.processorMhzLimit !== null ? labeledRow("CPU MHz Limit", String(mi.processorMhzLimit)) : ""}
		${mi.processorMaxIdleState !== null ? labeledRow("CPU Max Idle State", String(mi.processorMaxIdleState)) : ""}
		${mi.processorCurrentIdleState !== null ? labeledRow("CPU Current Idle State", String(mi.processorCurrentIdleState)) : ""}
	`;
};

export class SummaryView implements IContentRenderer {
	element: HTMLElement;

	constructor(element: HTMLElement) {
		this.element = element;
	}

	init(_: GroupPanelPartInitParameters): void {
		this.doRender();
	}

	private doRender(): void {
		const di = DBG;
		const streamTypes =
			di.streamTypes.length > 0
				? di.streamTypes.map(getMinidumpStreamTypeName).join(", ")
				: "none";

		render(
			html`
				<section class="dump-info-panel" aria-label="Dump Summary">
					<h2 class="dump-info-panel__title m0">Dump Summary</h2>
					${labeledRow("Checksum", fmtHex(di.checksum, 8))}
					${labeledRow("Timestamp", formatTimestamp(di.timestamp))}
					${labeledRow("Flags", fmtHex(di.flags, 16))}
					${labeledRow("Streams", String(di.streamCount))}
					${labeledRow("Stream Types", streamTypes)}
					${systemInfoTemplate()}
					${miscInfoTemplate()}
				</section>
			`,
			this.element,
		);
	}

	dispose(): void {}
}
