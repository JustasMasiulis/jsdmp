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
import type { SignalHandle } from "../lib/reactive";
import { renderSegments } from "../lib/syntaxHighlight";

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

		this.appendOutputLine("Type .help for a list of commands");
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
