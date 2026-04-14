export type WasmExports = {
	wasm_get_disassembly_buffer: () => number;
	wasm_get_decoded_buffer: () => number;
	wasm_amd64_decode_length: (length: number) => number;
	wasm_amd64_decode_full: (length: number, runtimeAddress: bigint) => number;
	wasm_arm64_decode_full: (length: number, runtimeAddress: bigint) => number;

	decoded_buffer: number;
	disassembly_buffer: number;
};

export const WASM_MEMORY = new WebAssembly.Memory({
	initial: 32,
	maximum: 32,
	shared: true,
});

export let WASM_EXPORTS: WasmExports | null = null;

export const __setWasmExportsForTesting = (wasmExports: WasmExports | null) => {
	WASM_EXPORTS = wasmExports;
};

export const loadWasm = async (): Promise<void> => {
	if (typeof window === "undefined") {
		return Promise.resolve();
	}

	const response = await fetch("/web_dmp.wasm");
	if (!response.ok) {
		throw new Error(`HTTP ${response.status} for web_dmp.wasm`);
	}

	const module = await WebAssembly.compileStreaming(response);
	const instance = await WebAssembly.instantiate(module, {
		env: { memory: WASM_MEMORY },
	});

	const exports = instance.exports as Omit<
		WasmExports,
		"decoded_buffer" | "disassembly_buffer"
	>;

	WASM_EXPORTS = {
		...exports,
		decoded_buffer: exports.wasm_get_decoded_buffer(),
		disassembly_buffer: exports.wasm_get_disassembly_buffer(),
	};
};
