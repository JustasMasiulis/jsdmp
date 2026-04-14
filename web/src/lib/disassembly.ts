/** biome-ignore-all lint/style/useTemplate: string concatenation has better performance */
import { ProcessorArch } from "./debug_interface";
import {
	type InstrTextSegment,
	parseInstructionText,
} from "./instructionParser";
import { WASM_EXPORTS, WASM_MEMORY } from "./wasm";

export { ProcessorArch } from "./debug_interface";
export type { InstrTextSegment } from "./instructionParser";
export { joinSegmentText, seg } from "./instructionParser";

export const AMD64_MAX_INSTR_LEN = 15;

export const maxInstructionLength = (arch: number): number =>
	arch === ProcessorArch.ARCH_AMD64 ? AMD64_MAX_INSTR_LEN : 4;

export type DecodedControlFlowKind =
	| "none"
	| "call"
	| "conditional_branch"
	| "unconditional_branch"
	| "return"
	| "interrupt"
	| "syscall"
	| "system";

export type DecodedControlFlow = {
	kind: DecodedControlFlowKind;
	directTargetAddress: bigint | null;
};

export type DecodedInstruction = {
	length: number;
	bytes: Uint8Array;
	mnemonic: string;
	operandSegments: InstrTextSegment[];
	controlFlow: DecodedControlFlow;
	ripRelativeTargets: bigint[];
};

export type DecodedInstructionHeader = {
	opcode: number;
	length: number;
	operandCount: number;
	controlFlowKind: number;
	hasDirectTarget: boolean;
	attributes: bigint;
	directTarget: bigint;
	archHeader: number;
};

const toControlFlowKind = (value: number): DecodedControlFlowKind => {
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

export const readPackedHeader = (view: DataView): DecodedInstructionHeader => {
	const word0 = view.getUint32(0, true);
	const archHeader = view.getUint32(4, true);
	const attributes = view.getBigUint64(8, true);
	const directTarget = view.getBigUint64(16, true);

	return {
		opcode: (word0 >>> 18) & 0x3fff,
		length: (word0 >>> 14) & 0xf,
		operandCount: (word0 >>> 11) & 0x7,
		controlFlowKind: (word0 >>> 8) & 0x7,
		hasDirectTarget: ((word0 >>> 7) & 1) !== 0,
		attributes,
		directTarget,
		archHeader,
	};
};

export const decodeInstruction = (
	bytes: Uint8Array,
	runtimeAddress: bigint,
	arch: number,
): DecodedInstruction | null => {
	const wasm = WASM_EXPORTS;
	if (!wasm) return null;

	let availableLen: number;
	let decodeFn: (length: number, runtimeAddress: bigint) => number;
	switch (arch) {
		case ProcessorArch.ARCH_AMD64:
			if (bytes.byteLength === 0) return null;
			availableLen = Math.min(bytes.byteLength, AMD64_MAX_INSTR_LEN);
			decodeFn = wasm.wasm_amd64_decode_full;
			break;
		case ProcessorArch.ARCH_ARM64:
			if (bytes.byteLength < 4) return null;
			availableLen = Math.min(bytes.byteLength, 4);
			decodeFn = wasm.wasm_arm64_decode_full;
			break;
		default:
			throw new Error(`Unsupported architecture: ${arch}`);
	}

	new Uint8Array(WASM_MEMORY.buffer).set(
		bytes.subarray(0, availableLen),
		wasm.disassembly_buffer,
	);

	if (decodeFn(availableLen, runtimeAddress) < 0) return null;

	const bufBase = wasm.decoded_buffer;
	const view = new DataView(WASM_MEMORY.buffer, bufBase, 256);

	const word0 = view.getUint32(0, true);
	const length = (word0 >>> 14) & 0xf;
	const controlFlowKind = (word0 >>> 8) & 0x7;
	const hasDirectTarget = ((word0 >>> 7) & 1) !== 0;
	const directTarget = view.getBigUint64(16, true);

	const ripTargetCount = view.getUint8(24);
	const stringLength = view.getUint8(25);

	const strBytes = new Uint8Array(
		WASM_MEMORY.buffer,
		bufBase + 26,
		stringLength,
	);
	const instrText = String.fromCharCode(...strBytes);

	const ripRelativeTargets: bigint[] = [];
	const ripBase = bufBase + 26 + stringLength;
	for (let i = 0; i < ripTargetCount; i++) {
		const rv = new DataView(WASM_MEMORY.buffer, ripBase + i * 8, 8);
		ripRelativeTargets.push(rv.getBigUint64(0, true));
	}

	const directTargetAddr = hasDirectTarget ? directTarget : null;
	const { mnemonic, operandSegments } = parseInstructionText(
		instrText,
		directTargetAddr,
		ripRelativeTargets,
	);

	return {
		length,
		bytes: bytes.slice(0, length),
		mnemonic,
		operandSegments,
		controlFlow: {
			kind: toControlFlowKind(controlFlowKind),
			directTargetAddress: directTargetAddr,
		},
		ripRelativeTargets,
	};
};

export const decodeInstructionLength = (
	bytes: Uint8Array,
	arch: number,
): number => {
	const wasm = WASM_EXPORTS;
	if (!wasm) return -1;

	if (bytes.byteLength === 0) return -1;

	switch (arch) {
		case ProcessorArch.ARCH_AMD64: {
			if (bytes.byteLength === 0) return -1;
			const availableLen = Math.min(bytes.byteLength, AMD64_MAX_INSTR_LEN);

			new Uint8Array(WASM_MEMORY.buffer).set(
				bytes.subarray(0, availableLen),
				wasm.disassembly_buffer,
			);

			return wasm.wasm_amd64_decode_length(availableLen);
		}
		case ProcessorArch.ARCH_ARM64:
			if (bytes.byteLength < 4) return -1;
			return 4;
		default:
			throw new Error(`Unsupported architecture: ${arch}`);
	}
};
