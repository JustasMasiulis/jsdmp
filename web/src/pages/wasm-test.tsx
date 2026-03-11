import { createSignal, Show } from "solid-js";
import DumpSummary, { type ParsedDumpInfo } from "../components/DumpSummary";
import type { WasmDisassemblerExports } from "../lib/disassembly";
import { MiniDump } from "../lib/minidump";

type WasmExports = WasmDisassemblerExports;

const g_memory = new WebAssembly.Memory({
	initial: 16n,
	maximum: 16n,
	shared: true,
	address: "i64",
});

let g_exports: WasmExports;

async function initWasm() {
	if (g_exports) return;

	const response = await fetch("/web_dmp.wasm");
	if (!response.ok) {
		throw new Error(`HTTP ${response.status} for wasm_dmp.wasm`);
	}

	const imports: WebAssembly.Imports = {
		env: {
			memory: g_memory,
		},
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
	const [isDragging, setIsDragging] = createSignal(false);
	let dumpInputRef: HTMLInputElement | undefined;
	let dragDepth = 0;

	const allowedDumpExtensions = [".dmp", ".mdmp", ".dump"];

	const formatBytes = (bytes: number) => {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		if (bytes < 1024 * 1024 * 1024)
			return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
				associatedThreads: parsed.associatedThreads,
				moduleList: parsed.moduleList,
				unloadedModuleList: parsed.unloadedModuleList,
				memoryRanges: parsed.memoryRanges,
				readMemoryAt: parsed.readMemoryAt.bind(parsed),
				readMemoryViewAt: parsed.readMemoryViewAt.bind(parsed),
				findMemoryRangeAt: parsed.findMemoryRangeAt.bind(parsed),
				debugView: null,
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

	const handleFileInputChange = (
		event: Event & { currentTarget: HTMLInputElement },
	) => {
		void selectDumpFile(event.currentTarget.files?.[0]);
	};

	const handleDragEnter = (event: DragEvent) => {
		event.preventDefault();
		dragDepth += 1;
		setIsDragging(true);
	};

	const handleDragOver = (event: DragEvent) => {
		event.preventDefault();
		if (event.dataTransfer) {
			event.dataTransfer.dropEffect = "copy";
		}
	};

	const handleDragLeave = (event: DragEvent) => {
		event.preventDefault();
		dragDepth = Math.max(0, dragDepth - 1);
		setIsDragging(dragDepth > 0);
	};

	const handleDrop = (event: DragEvent) => {
		event.preventDefault();
		dragDepth = 0;
		setIsDragging(false);
		void selectDumpFile(event.dataTransfer?.files?.[0]);
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

			<button
				type="button"
				class={`dump-dropzone${isDragging() ? " is-dragging" : ""}`}
				aria-label="Upload dump file"
				onClick={openFilePicker}
				onDragEnter={handleDragEnter}
				onDragOver={handleDragOver}
				onDragLeave={handleDragLeave}
				onDrop={handleDrop}
			>
				<span class="dump-dropzone__title">Drop dump file here</span>
				<span class="dump-dropzone__hint">
					or click to browse ({allowedDumpExtensions.join(", ")})
				</span>
			</button>

			<p class="dump-dropzone__file">
				{dumpFile()
					? `Selected: ${dumpFile()?.name} (${formatBytes(dumpFile()?.size ?? 0)})`
					: "No dump file selected."}
			</p>

			{isParsing() ? (
				<p class="dump-dropzone__file">Parsing dump file...</p>
			) : null}

			{uploadError() ? (
				<p class="dump-dropzone__error">{uploadError()}</p>
			) : null}

			<Show when={dumpInfo()}>
				{(info) => <DumpSummary dumpInfo={info()} />}
			</Show>
		</section>
	);
}
