export type WasmExports = {
	wasm_get_disassembly_buffer: () => number;
	wasm_get_disassembled_text: () => number;
	wasm_get_disassembled_length: () => number;
	wasm_get_disassembled_mnemonic: () => number;
	wasm_get_disassembled_control_flow_kind: () => number;
	wasm_get_disassembled_has_direct_target: () => number;
	wasm_get_disassembled_direct_target: () => bigint;
	wasm_disassemble: (length: number, runtimeAddress: bigint) => number;
	wasm_mnemonic_string: (mnemonic: number) => number;
};

export const WASM_MEMORY = new WebAssembly.Memory({
	initial: 16,
	maximum: 16,
	shared: true,
});

// will be initialized before the app is rendered
export let WASM_EXPORTS: WasmExports | null = null;

export const __setWasmExportsForTesting = (wasmExports: WasmExports | null) => {
	WASM_EXPORTS = wasmExports;
};

const loadWasm = async (): Promise<void> => {
	const response = await fetch("/web_dmp.wasm");
	if (!response.ok) {
		throw new Error(`HTTP ${response.status} for web_dmp.wasm`);
	}

	const module = await WebAssembly.compileStreaming(response);
	const instance = await WebAssembly.instantiate(module, {
		env: { memory: WASM_MEMORY },
	});

	WASM_EXPORTS = instance.exports as WasmExports;
};

export const WASM_PROMISE =
	typeof window === "undefined" ? Promise.resolve() : loadWasm();
