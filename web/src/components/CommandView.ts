import type {
	GroupPanelPartInitParameters,
	IContentRenderer,
} from "dockview-core";
import {
	type CommandOutputLine,
	createCommandEngine,
} from "../lib/commandEngine";
import type { DebugThread } from "../lib/debug_interface";
import { DBG } from "../lib/debugState";
import { fmtHex, fmtOs, fmtProductAndSuite } from "../lib/formatting";
import { getMinidumpStreamTypeName } from "../lib/minidump_debug_interface";
import type { SignalHandle } from "../lib/reactive";
import { renderSegments } from "../lib/syntaxHighlight";

const formatTimestamp = (timestamp: number): string => {
	if (!timestamp) return "0 (unset)";
	return `${timestamp} (${new Date(timestamp * 1000).toISOString()})`;
};

const collectStartupBanner = (): string[] => {
	const lines: string[] = [];
	const di = DBG;

	lines.push("************* Dump Summary *************");
	lines.push(`Checksum:     ${fmtHex(di.checksum, 8)}`);
	lines.push(`Timestamp:    ${formatTimestamp(di.timestamp)}`);
	lines.push(`Flags:        ${fmtHex(di.flags, 16)}`);
	lines.push(`Streams:      ${di.streamCount}`);
	const streamTypes =
		di.streamTypes.length > 0
			? di.streamTypes.map(getMinidumpStreamTypeName).join(", ")
			: "none";
	lines.push(`Stream Types: ${streamTypes}`);

	const si = di.systemInfo;
	if (si) {
		lines.push("");
		lines.push("************* System Information *************");
		lines.push(fmtOs(si));
		lines.push(fmtProductAndSuite(si));
		lines.push(
			`CPU Revision: level ${si.processorLevel}, rev ${fmtHex(si.processorRevision, 4)}`,
		);
		if (si.cpu.type === "x86") {
			lines.push(`CPU Vendor:   ${si.cpu.vendorId || "unknown"}`);
		} else {
			lines.push(
				`CPU Features: ${fmtHex(si.cpu.processorFeatures[0], 16)}, ${fmtHex(si.cpu.processorFeatures[1], 16)}`,
			);
		}
	}

	const mi = di.miscInfo;
	if (mi) {
		lines.push("");
		lines.push("************* Misc Information *************");
		lines.push(`MiscInfo Size:   ${mi.sizeOfInfo}`);
		lines.push(`MiscInfo Flags1: ${fmtHex(mi.flags1, 8)}`);
		const miscRow = (label: string, value: number | null, suffix = "") => {
			if (value !== null) lines.push(`${label}${value}${suffix}`);
		};
		miscRow("Process ID:               ", mi.processId);
		if (mi.processCreateTime !== null) {
			lines.push(
				`Process Create Time:      ${formatTimestamp(mi.processCreateTime)}`,
			);
		}
		miscRow("Process User Time:        ", mi.processUserTime, " sec");
		miscRow("Process Kernel Time:      ", mi.processKernelTime, " sec");
		miscRow("CPU Max MHz:              ", mi.processorMaxMhz);
		miscRow("CPU Current MHz:          ", mi.processorCurrentMhz);
		miscRow("CPU MHz Limit:            ", mi.processorMhzLimit);
		miscRow("CPU Max Idle State:       ", mi.processorMaxIdleState);
		miscRow("CPU Current Idle State:   ", mi.processorCurrentIdleState);
	}

	const ei = di.exceptionInfo;
	lines.push("");
	lines.push("************* Exception *************");
	if (!ei) {
		lines.push("No exception information");
	} else {
		const r = ei.exceptionRecord;
		lines.push(`Exception Thread ID:  ${ei.threadId}`);
		lines.push(`Exception Code:       ${fmtHex(r.exceptionCode, 8)}`);
		lines.push(`Exception Flags:      ${fmtHex(r.exceptionFlags, 8)}`);
		lines.push(`Exception Address:    ${fmtHex(r.exceptionAddress, 16)}`);
		lines.push(`Exception Record:     ${fmtHex(r.exceptionRecord, 16)}`);
		lines.push(`Exception Parameters: ${r.numberParameters}`);
		lines.push(
			`Exception Context:    size=${ei.contextLocation.size}, rva=${fmtHex(ei.contextLocation.rva, 8)}`,
		);
		if (r.numberParameters > 0) {
			r.exceptionInformation
				.slice(0, r.numberParameters)
				.forEach((value, index) => {
					lines.push(`  [${index}] = ${fmtHex(value, 16)}`);
				});
		}
	}

	lines.push("");
	lines.push("Type .help for a list of commands");
	return lines;
};

export class CommandView implements IContentRenderer {
	element: HTMLElement;
	private section: HTMLElement;
	private output: HTMLElement;
	private input: HTMLInputElement;
	private promptSpan: HTMLElement;
	private engine: ReturnType<typeof createCommandEngine>;
	private handle: SignalHandle<DebugThread | null>;

	private static readonly MAX_OUTPUT_LINES = 5000;
	private static readonly MAX_HISTORY = 500;

	private history: string[] = [];
	private historyIndex = 0;
	private savedInput = "";
	private outputLineCount = 0;

	constructor(element: HTMLElement) {
		this.element = element;
		this.engine = createCommandEngine(DBG);

		this.section = document.createElement("section");
		this.section.className = "command-view";

		this.output = document.createElement("div");
		this.output.className = "command-view__output";

		const inputRow = document.createElement("div");
		inputRow.className = "command-view__input-row";

		this.promptSpan = document.createElement("span");
		this.promptSpan.className = "command-view__prompt";

		this.input = document.createElement("input");
		this.input.className = "command-view__input";
		this.input.type = "text";
		this.input.spellcheck = false;
		this.input.autocomplete = "off";
		this.input.addEventListener("keydown", this.onKeyDown);

		inputRow.append(this.promptSpan, this.input);
		this.section.append(this.output, inputRow);
		this.element.append(this.section);

		this.handle = DBG.currentThread.subscribe(() => this.updatePrompt());
		this.updatePrompt();

		for (const line of collectStartupBanner()) {
			this.appendOutputLine(line);
		}
	}

	init(_: GroupPanelPartInitParameters): void {}

	private updatePrompt(): void {
		const threads = DBG.threads.state;
		const current = DBG.currentThread.state;
		const idx = current ? threads.indexOf(current) : 0;
		const padded = String(Math.max(idx, 0)).padStart(3, "0");
		this.promptSpan.textContent = `0:${padded}> `;
	}

	private appendOutputLine(
		content: CommandOutputLine,
		modifier?: "error" | "echo",
	): void {
		const line = document.createElement("div");
		line.className = "command-view__output-line";
		if (modifier) {
			line.classList.add(`command-view__output-line--${modifier}`);
		}
		if (typeof content === "string") {
			line.textContent = content;
		} else {
			renderSegments(line, content);
		}
		this.output.append(line);
		this.outputLineCount++;

		while (
			this.outputLineCount > CommandView.MAX_OUTPUT_LINES &&
			this.output.firstChild
		) {
			this.output.firstChild.remove();
			this.outputLineCount--;
		}

		this.output.scrollTop = this.output.scrollHeight;
	}

	private onKeyDown = (e: KeyboardEvent): void => {
		if (e.key === "Enter") {
			e.preventDefault();
			const value = this.input.value;
			this.input.value = "";

			if (value.length > 0) {
				this.history.push(value);
				if (this.history.length > CommandView.MAX_HISTORY) {
					this.history.splice(0, this.history.length - CommandView.MAX_HISTORY);
				}
			}
			this.historyIndex = this.history.length;
			this.savedInput = "";

			const prompt = this.promptSpan.textContent ?? "0:000> ";
			this.appendOutputLine(prompt + value, "echo");
			this.executeCommand(value);
			return;
		}

		if (e.key === "ArrowUp") {
			e.preventDefault();
			if (this.history.length === 0) return;
			if (this.historyIndex === this.history.length) {
				this.savedInput = this.input.value;
			}
			if (this.historyIndex > 0) {
				this.historyIndex--;
			}
			this.input.value = this.history[this.historyIndex];
			return;
		}

		if (e.key === "ArrowDown") {
			e.preventDefault();
			if (this.historyIndex < this.history.length) {
				this.historyIndex++;
			}
			this.input.value =
				this.historyIndex === this.history.length
					? this.savedInput
					: this.history[this.historyIndex];
		}
	};

	private async executeCommand(value: string): Promise<void> {
		this.input.disabled = true;
		try {
			const result = await this.engine.execute(value);
			for (const line of result.lines) {
				this.appendOutputLine(line, result.isError ? "error" : undefined);
			}
		} catch (err) {
			this.appendOutputLine(
				String(err instanceof Error ? err.message : err),
				"error",
			);
		}
		this.input.disabled = false;
		this.input.focus();
	}

	dispose(): void {
		this.handle.dispose();
		this.section.remove();
	}
}
