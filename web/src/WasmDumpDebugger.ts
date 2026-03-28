import { DockviewDumpLayout } from "./components/DockviewDumpLayout";
import type { ParsedDumpInfo } from "./lib/dumpInfo";
import {
	ALLOWED_DUMP_EXTENSIONS,
	isSupportedDumpFile,
	parseDumpFile,
} from "./lib/dumpInfo";

export function initWasmDumpDebugger(root: HTMLElement): void {
	new WasmDumpDebugger(root);
}

class WasmDumpDebugger {
	private shell: HTMLElement;
	private fileInput: HTMLInputElement;
	private dropzone: HTMLButtonElement;
	private parsingMsg: HTMLParagraphElement;
	private errorMsg: HTMLParagraphElement;
	private warningMsg: HTMLParagraphElement;
	private layout: DockviewDumpLayout | null = null;
	private dragDepth = 0;

	constructor(root: HTMLElement) {
		this.shell = document.createElement("section");
		this.shell.className = "wasm-debugger-shell";
		root.append(this.shell);

		// Hidden file input
		this.fileInput = document.createElement("input");
		this.fileInput.type = "file";
		this.fileInput.accept = ALLOWED_DUMP_EXTENSIONS.join(",");
		this.fileInput.style.display = "none";
		this.fileInput.addEventListener("change", this.onFileInputChange);
		this.shell.append(this.fileInput);

		// Drop zone button
		this.dropzone = document.createElement("button");
		this.dropzone.type = "button";
		this.dropzone.className = "dump-dropzone";
		this.dropzone.setAttribute("aria-label", "Upload dump file");
		const title = document.createElement("span");
		title.className = "dump-dropzone__title";
		title.textContent = "Drop dump file here";
		const hint = document.createElement("span");
		hint.className = "dump-dropzone__hint";
		hint.textContent = `or click to browse (${ALLOWED_DUMP_EXTENSIONS.join(", ")})`;
		this.dropzone.append(title, hint);
		this.dropzone.addEventListener("click", () => this.fileInput.click());
		this.dropzone.addEventListener("dragenter", this.onDragEnter);
		this.dropzone.addEventListener("dragover", this.onDragOver);
		this.dropzone.addEventListener("dragleave", this.onDragLeave);
		this.dropzone.addEventListener("drop", this.onDrop);
		this.shell.append(this.dropzone);

		// Status messages (hidden initially)
		this.parsingMsg = document.createElement("p");
		this.parsingMsg.className = "dump-dropzone__file";
		this.parsingMsg.textContent = "Parsing dump file...";
		this.parsingMsg.hidden = true;
		this.shell.append(this.parsingMsg);

		this.errorMsg = document.createElement("p");
		this.errorMsg.className = "dump-dropzone__error";
		this.errorMsg.hidden = true;
		this.shell.append(this.errorMsg);

		this.warningMsg = document.createElement("p");
		this.warningMsg.className = "dump-dropzone__error";
		this.warningMsg.hidden = true;
		this.shell.append(this.warningMsg);

		// Global drag events so dragging anywhere onto the page works
		this.shell.addEventListener("dragenter", this.onDragEnter);
		this.shell.addEventListener("dragover", this.onDragOver);
		this.shell.addEventListener("dragleave", this.onDragLeave);
		this.shell.addEventListener("drop", this.onDrop);
	}

	// ─── drag & drop ──────────────────────────────────────────────────────────

	private onDragEnter = (event: DragEvent): void => {
		event.preventDefault();
		this.dragDepth += 1;
		this.shell.classList.add("is-dragging");
		this.dropzone.classList.add("is-dragging");
	};

	private onDragOver = (event: DragEvent): void => {
		event.preventDefault();
		if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
	};

	private onDragLeave = (event: DragEvent): void => {
		event.preventDefault();
		this.dragDepth = Math.max(0, this.dragDepth - 1);
		if (this.dragDepth === 0) {
			this.shell.classList.remove("is-dragging");
			this.dropzone.classList.remove("is-dragging");
		}
	};

	private onDrop = (event: DragEvent): void => {
		event.preventDefault();
		this.dragDepth = 0;
		this.shell.classList.remove("is-dragging");
		this.dropzone.classList.remove("is-dragging");
		const file = event.dataTransfer?.files?.[0];
		if (file) void this.loadFile(file);
	};

	private onFileInputChange = (): void => {
		const file = this.fileInput.files?.[0];
		if (file) void this.loadFile(file);
	};

	// ─── file loading ─────────────────────────────────────────────────────────

	private async loadFile(file: File): Promise<void> {
		if (!isSupportedDumpFile(file)) {
			this.setError(
				`Unsupported file type. Please use ${ALLOWED_DUMP_EXTENSIONS.join(", ")}.`,
			);
			return;
		}

		document.title = file.name;
		this.setError("");
		this.setWarning("");
		this.setParsing(true);
		this.showDropzone(true);

		let dumpInfo: ParsedDumpInfo;
		try {
			dumpInfo = await parseDumpFile(file);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.setError(`Failed to parse dump file: ${message}`);
			this.setParsing(false);
			return;
		}

		this.setParsing(false);

		if (dumpInfo.contextWarning) {
			this.setWarning(dumpInfo.contextWarning);
		}

		this.mountLayout(dumpInfo);
	}

	// ─── UI state ─────────────────────────────────────────────────────────────

	private setParsing(active: boolean): void {
		this.parsingMsg.hidden = !active;
	}

	private setError(msg: string): void {
		this.errorMsg.textContent = msg;
		this.errorMsg.hidden = !msg;
	}

	private setWarning(msg: string): void {
		this.warningMsg.textContent = msg;
		this.warningMsg.hidden = !msg;
	}

	private showDropzone(visible: boolean): void {
		this.dropzone.hidden = !visible;
	}

	private mountLayout(dumpInfo: ParsedDumpInfo): void {
		this.layout?.dispose();
		this.showDropzone(false);
		this.layout = new DockviewDumpLayout(this.shell, dumpInfo);
	}
}
