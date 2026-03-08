import { Show, createSignal } from "solid-js";
import DumpSummary, { type ParsedDumpInfo } from "../components/DumpSummary";
import {
	MiniDump,
} from "../lib/minidump";

type WasmExports = {
	wasm_get_disassembled_instruction: () => BigInt;
	wasm_get_disassembly_buffer: () => BigInt;
	wasm_disassemble: (length: number, runtime_address: number) => number;
	wasm_mnemonic_string: (mnemonic: number) => string;
}

let g_memory = new WebAssembly.Memory({
	initial: 16n,
	maximum: 16n,
	shared: true,
	address: "i64"
})

let g_exports: WasmExports;

async function initWasm() {
	if (g_exports) return;

	const response = await fetch("/web_dmp.wasm");
	if (!response.ok) {
		throw new Error(`HTTP ${response.status} for wasm_dmp.wasm`);
	}

	let imports: WebAssembly.Imports = {
		env: {
			memory: g_memory
		}
	};

	const module = await WebAssembly.compileStreaming(response);
	const instance = await WebAssembly.instantiate(module, imports);
	g_exports = instance.exports as WasmExports;
	console.log(g_exports);
}

initWasm();

export default function WasmTest() {
	const [dumpFile, setDumpFile] = createSignal<File | null>(null);
	const [dumpInfo, setDumpInfo] = createSignal<ParsedDumpInfo | null>(null);
	const [isParsing, setIsParsing] = createSignal(false);
	const [uploadError, setUploadError] = createSignal("");
	const [dragDepth, setDragDepth] = createSignal(0);
	const [isDragging, setIsDragging] = createSignal(false);
	let dumpInputRef: HTMLInputElement | undefined;

	const allowedDumpExtensions = [".dmp", ".mdmp", ".dump"];

	const formatBytes = (bytes: number) => {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
		return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
	};

	const isDumpFile = (file: File) => {
		const lowerName = file.name.toLowerCase();
		return allowedDumpExtensions.some((ext) => lowerName.endsWith(ext));
	};

	const selectDumpFile = async (file?: File) => {
		if (!file) return;

		if (!isDumpFile(file)) {
			setDumpFile(null);
			setDumpInfo(null);
			setUploadError(
				`Unsupported file type. Please use ${allowedDumpExtensions.join(", ")}.`,
			);
			return;
		}

		setDumpFile(file);
		setDumpInfo(null);
		setUploadError("");
		setIsParsing(true);

		try {
			const data = await file.arrayBuffer();
			const parsed = new MiniDump(data);
			const streamTypes = [...parsed.streams.keys()].sort((a, b) => a - b);

			setDumpInfo({
				checksum: parsed.checksum,
				timestamp: parsed.timestamp,
				flags: parsed.flags,
				streamCount: parsed.streams.size,
				streamTypes,
				systemInfo: parsed.systemInfo,
				miscInfo: parsed.miscInfo,
				exceptionStream: parsed.exceptionStream,
				threadList: parsed.threadList,
				threadInfoList: parsed.threadInfoList,
				associatedThreads: parsed.associatedThreads,
			});
		} catch (error) {
			setDumpInfo(null);
			const message = error instanceof Error ? error.message : String(error);
			setUploadError(`Failed to parse dump file: ${message}`);
		} finally {
			setIsParsing(false);
		}
	};

	const openFilePicker = () => {
		dumpInputRef?.click();
	};

	const handleFileInputChange = (event: Event & { currentTarget: HTMLInputElement }) => {
		void selectDumpFile(event.currentTarget.files?.[0]);
	};

	const handleDragEnter = (event: DragEvent) => {
		event.preventDefault();
		setDragDepth((prev) => {
			const next = prev + 1;
			setIsDragging(true);
			return next;
		});
	};

	const handleDragOver = (event: DragEvent) => {
		event.preventDefault();
		if (event.dataTransfer) {
			event.dataTransfer.dropEffect = "copy";
		}
	};

	const handleDragLeave = (event: DragEvent) => {
		event.preventDefault();
		setDragDepth((prev) => {
			const next = Math.max(0, prev - 1);
			setIsDragging(next > 0);
			return next;
		});
	};

	const handleDrop = (event: DragEvent) => {
		event.preventDefault();
		setDragDepth(0);
		setIsDragging(false);
		void selectDumpFile(event.dataTransfer?.files?.[0]);
	};

	const handleDropzoneKeyDown = (event: KeyboardEvent) => {
		if (event.key === "Enter" || event.key === " ") {
			event.preventDefault();
			openFilePicker();
		}
	};

	return (
		<section class="wasm-test-shell">
			<h1 class="m0">WASM dmp debugger</h1>

			<input
				ref={(element) => {
					dumpInputRef = element;
				}}
				type="file"
				accept={allowedDumpExtensions.join(",")}
				onChange={handleFileInputChange}
				style={{ display: "none" }}
			/>

			<div
				class={`dump-dropzone${isDragging() ? " is-dragging" : ""}`}
				role="button"
				tabindex={0}
				aria-label="Upload dump file"
				onClick={openFilePicker}
				onKeyDown={handleDropzoneKeyDown}
				onDragEnter={handleDragEnter}
				onDragOver={handleDragOver}
				onDragLeave={handleDragLeave}
				onDrop={handleDrop}
			>
				<p class="dump-dropzone__title">Drop dump file here</p>
				<p class="dump-dropzone__hint">
					or click to browse ({allowedDumpExtensions.join(", ")})
				</p>
			</div>

			<p class="dump-dropzone__file">
				{dumpFile()
					? `Selected: ${dumpFile()?.name} (${formatBytes(dumpFile()?.size ?? 0)})`
					: "No dump file selected."}
			</p>

			{isParsing() ? <p class="dump-dropzone__file">Parsing dump file...</p> : null}

			{uploadError() ? <p class="dump-dropzone__error">{uploadError()}</p> : null}

			<Show when={dumpInfo()}>{(info) => <DumpSummary dumpInfo={info()} />}</Show>
		</section>
	);
}
