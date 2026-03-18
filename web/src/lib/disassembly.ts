import { readCString } from "./reader";
import { WASM_EXPORTS, WASM_MEMORY } from "./wasm";

export const MAX_INSTRUCTION_LENGTH = 15;

export type DisassembledControlFlowKind =
	| "none"
	| "call"
	| "conditional_branch"
	| "unconditional_branch"
	| "return"
	| "interrupt"
	| "syscall"
	| "system";

export type DisassembledControlFlow = {
	kind: DisassembledControlFlowKind;
	hasFallthrough: boolean;
	hasDirectTarget: boolean;
	directTargetAddress: bigint | null;
};

export type DisassembledInstruction = {
	length: number;
	bytes: Uint8Array;
	mnemonicId: number;
	mnemonic: string;
	operands: string;
	controlFlow: DisassembledControlFlow;
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

const toControlFlowKind = (value: number): DisassembledControlFlowKind => {
	switch (value) {
		case 1:
			return "call";
		case 2:
			return "conditional_branch";
		case 3:
			return "unconditional_branch";
		case 4:
			return "return";
		case 5:
			return "interrupt";
		case 6:
			return "syscall";
		case 7:
			return "system";
		default:
			return "none";
	}
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

	const hasDirectTarget = wasm.wasm_get_disassembled_has_direct_target() !== 0;

	return {
		length,
		bytes: candidateBytes.slice(0, length),
		mnemonicId,
		mnemonic: parsed.mnemonic,
		operands: parsed.operands,
		controlFlow: {
			kind: toControlFlowKind(
				wasm.wasm_get_disassembled_control_flow_kind(),
			),
			hasFallthrough: wasm.wasm_get_disassembled_has_fallthrough() !== 0,
			hasDirectTarget,
			directTargetAddress: hasDirectTarget
				? wasm.wasm_get_disassembled_direct_target()
				: null,
		},
	};
};