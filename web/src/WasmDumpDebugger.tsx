import { createEffect, createResource, createSignal, Show } from "solid-js";
import DockviewDumpLayout from "./components/DockviewDumpLayout";
import type { ParsedDumpInfo } from "./lib/dumpInfo";
import {
	ALLOWED_DUMP_EXTENSIONS,
	isSupportedDumpFile,
	parseDumpFile,
} from "./lib/dumpInfo";
import { WASM_PROMISE } from "./lib/wasm";

const loadWasmRuntime = async () => {
	await WASM_PROMISE;
	return null;
};

type DumpFileSelectionActions = {
	setDumpFile: (file: File | null) => void;
	setDumpInfo: (dumpInfo: ParsedDumpInfo | null) => void;
	setIsParsing: (value: boolean) => void;
	setUploadError: (value: string) => void;
};

const selectDumpFile = async (
	file: File | undefined,
	actions: DumpFileSelectionActions,
) => {
	if (!file) {
		return;
	}

	if (!isSupportedDumpFile(file)) {
		actions.setDumpFile(null);
		actions.setDumpInfo(null);
		actions.setUploadError(
			`Unsupported file type. Please use ${ALLOWED_DUMP_EXTENSIONS.join(", ")}.`,
		);
		return;
	}

	actions.setDumpFile(file);
	actions.setDumpInfo(null);
	actions.setUploadError("");
	actions.setIsParsing(true);

	try {
		actions.setDumpInfo(await parseDumpFile(file));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		actions.setDumpInfo(null);
		actions.setUploadError(`Failed to parse dump file: ${message}`);
	} finally {
		actions.setIsParsing(false);
	}
};

const createDumpDropTarget = (onSelectFile: (file?: File) => void) => {
	const [isDragging, setIsDragging] = createSignal(false);
	let dragDepth = 0;

	const handleFileInputChange = (
		event: Event & { currentTarget: HTMLInputElement },
	) => {
		onSelectFile(event.currentTarget.files?.[0]);
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
		onSelectFile(event.dataTransfer?.files?.[0]);
	};

	return {
		handleDragEnter,
		handleDragLeave,
		handleDragOver,
		handleDrop,
		handleFileInputChange,
		isDragging,
	};
};

export default function WasmDumpDebugger() {
	createResource(loadWasmRuntime);

	const [dumpFile, setDumpFile] = createSignal<File | null>(null);
	const [dumpInfo, setDumpInfo] = createSignal<ParsedDumpInfo | null>(null);
	const [isParsing, setIsParsing] = createSignal(false);
	const [uploadError, setUploadError] = createSignal("");
	let dumpInputRef!: HTMLInputElement;

	const handleDumpFileSelect = (file?: File) => {
		void selectDumpFile(file, {
			setDumpFile,
			setDumpInfo,
			setIsParsing,
			setUploadError,
		});
	};

	createEffect(() => {
		const file = dumpFile();
		document.title = file ? file.name : "WASM Dump Debugger";
	});

	const dropTarget = createDumpDropTarget(handleDumpFileSelect);
	return (
		<section
			class={`wasm-debugger-shell${dropTarget.isDragging() ? " is-dragging" : ""}`}
		>
			<input
				ref={dumpInputRef}
				type="file"
				accept={ALLOWED_DUMP_EXTENSIONS.join(",")}
				onChange={dropTarget.handleFileInputChange}
				style={{ display: "none" }}
			/>

			<Show when={!dumpInfo()}>
				<button
					type="button"
					class={`dump-dropzone${dropTarget.isDragging() ? " is-dragging" : ""}`}
					aria-label="Upload dump file"
					onClick={() => dumpInputRef.click()}
					onDragEnter={dropTarget.handleDragEnter}
					onDragOver={dropTarget.handleDragOver}
					onDragLeave={dropTarget.handleDragLeave}
					onDrop={dropTarget.handleDrop}
				>
					<span class="dump-dropzone__title">Drop dump file here</span>
					<span class="dump-dropzone__hint">
						or click to browse ({ALLOWED_DUMP_EXTENSIONS.join(", ")})
					</span>
				</button>
			</Show>

			<Show when={isParsing()}>
				<p class="dump-dropzone__file">Parsing dump file...</p>
			</Show>
			<Show when={uploadError()}>
				<p class="dump-dropzone__error">{uploadError()}</p>
			</Show>
			<Show when={dumpInfo()?.contextWarning}>
				<p class="dump-dropzone__error">{dumpInfo()?.contextWarning}</p>
			</Show>
			<Show when={dumpInfo()}>
				{(info) => <DockviewDumpLayout dumpInfo={info()} />}
			</Show>
		</section>
	);
}
