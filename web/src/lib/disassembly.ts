import { readCString } from "./reader";
import { getWasm, WASM_EXPORTS, WASM_MEMORY } from "./wasm";

export const MAX_INSTRUCTION_LENGTH = 15;

export type DisassembledInstruction = {
	length: number;
	bytes: Uint8Array;
	mnemonic: string;
	operands: string;
};

const parseFormattedInstruction = (
	formatted: string,
	fallbackMnemonic: string,
): { mnemonic: string; operands: string } => {
	const trimmed = formatted.trim();
	if (!trimmed) {
		return {
			mnemonic: fallbackMnemonic || "???",
			operands: "",
		};
	}

	const firstSpace = trimmed.search(/\s/);
	if (firstSpace < 0) {
		return {
			mnemonic: trimmed,
			operands: "",
		};
	}

	return {
		mnemonic: trimmed.slice(0, firstSpace),
		operands: trimmed.slice(firstSpace).trim(),
	};
};

export const disassembleInstruction = (
	bytes: Uint8Array,
	runtimeAddress: bigint,
): DisassembledInstruction | null => {
	if (bytes.byteLength === 0) {
		return null;
	}

	const wasm = WASM_EXPORTS;

	const candidateBytes =
		bytes.byteLength > MAX_INSTRUCTION_LENGTH
			? bytes.subarray(0, MAX_INSTRUCTION_LENGTH)
			: bytes;

	const disassemblyBufferPtr = wasm.wasm_get_disassembly_buffer();
	const wasmBytes = new Uint8Array(WASM_MEMORY.buffer);
	if (disassemblyBufferPtr + candidateBytes.byteLength > wasmBytes.byteLength) {
		return null;
	}
	wasmBytes.set(candidateBytes, disassemblyBufferPtr);

	const status = wasm.wasm_disassemble(
		candidateBytes.byteLength,
		runtimeAddress,
	);

	if (status < 0) {
		return null;
	}

	const length = wasm.wasm_get_disassembled_length();

	const mnemonicId = wasm.wasm_get_disassembled_mnemonic();

	const mnemonicPointer = wasm.wasm_mnemonic_string(mnemonicId);
	const mnemonic = readCString(wasmBytes, mnemonicPointer, 48);

	const formattedPointer = wasm.wasm_get_disassembled_text();
	const formattedText = readCString(wasmBytes, formattedPointer, 96);

	const parsed = parseFormattedInstruction(formattedText, mnemonic);

	return {
		length,
		bytes: candidateBytes.slice(0, length),
		mnemonic: parsed.mnemonic,
		operands: parsed.operands,
	};
};
