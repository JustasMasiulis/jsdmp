import {
	type DecodedInstructionHeader,
	type DecodedOperand,
	formatInstructionOperands,
} from "./intelFormatter";
import { readCString } from "./reader";
import { WASM_EXPORTS, WASM_MEMORY } from "./wasm";

export type {
	DecodedInstructionHeader,
	DecodedOperand,
} from "./intelFormatter";

export const MAX_INSTRUCTION_LENGTH = 15;

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
	mnemonicId: number;
	controlFlow: DecodedControlFlow;
	prefix: string;
	mnemonic: string;
	operands: string;
	header: DecodedInstructionHeader;
	decodedOperands: DecodedOperand[];
};

const SIZE_INDEX_TABLE = [
	0, 8, 16, 32, 64, 80, 128, 256, 512, 1024, 2048, 4096,
];
const WIDTH_TABLE = [16, 32, 64];
const SCALE_TABLE = [1, 2, 4, 8];
const AVX_VL_TABLE = [0, 128, 256, 512];

const ATTRIB_HAS_LOCK = 1n << 27n;
const ATTRIB_HAS_REP = 1n << 28n;
const ATTRIB_HAS_REPE = 1n << 29n;
const ATTRIB_HAS_REPNE = 1n << 30n;
const ATTRIB_HAS_BND = 1n << 31n;
const ATTRIB_HAS_XACQUIRE = 1n << 32n;
const ATTRIB_HAS_XRELEASE = 1n << 33n;
const ATTRIB_HAS_NOTRACK = 1n << 36n;

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

const extractPrefix = (attributes: bigint): string => {
	let result = "";
	if (attributes & ATTRIB_HAS_XACQUIRE)
		result += (result ? " " : "") + "xacquire";
	if (attributes & ATTRIB_HAS_XRELEASE)
		result += (result ? " " : "") + "xrelease";
	if (attributes & ATTRIB_HAS_LOCK) result += (result ? " " : "") + "lock";
	if (attributes & ATTRIB_HAS_REP) result += (result ? " " : "") + "rep";
	if (attributes & ATTRIB_HAS_REPE) result += (result ? " " : "") + "repe";
	if (attributes & ATTRIB_HAS_REPNE) result += (result ? " " : "") + "repne";
	if (attributes & ATTRIB_HAS_BND) result += (result ? " " : "") + "bnd";
	if (attributes & ATTRIB_HAS_NOTRACK)
		result += (result ? " " : "") + "notrack";
	return result;
};

const readPackedHeader = (view: DataView): DecodedInstructionHeader => {
	const word0 = view.getUint32(0, true);
	const word1 = view.getUint16(4, true);
	const attributes = view.getBigUint64(8, true);
	const directTarget = view.getBigUint64(16, true);

	return {
		mnemonic: (word0 >>> 21) & 0x7ff,
		length: (word0 >>> 17) & 0xf,
		operandCount: (word0 >>> 14) & 0x7,
		controlFlowKind: (word0 >>> 11) & 0x7,
		hasDirectTarget: ((word0 >>> 10) & 1) !== 0,
		encoding: (word0 >>> 7) & 0x7,
		addressWidth: WIDTH_TABLE[(word0 >>> 5) & 0x3],
		operandWidth: WIDTH_TABLE[(word0 >>> 3) & 0x3],
		stackWidth: WIDTH_TABLE[(word0 >>> 1) & 0x3],
		avxHasSae: (word0 & 1) !== 0,
		attributes,
		directTarget,
		avxVectorLength: AVX_VL_TABLE[(word1 >>> 14) & 0x3],
		avxMaskReg: (word1 >>> 11) & 0x7,
		avxBroadcast: (word1 >>> 7) & 0xf,
		avxRounding: (word1 >>> 5) & 0x3,
		avxMaskMode: (word1 >>> 2) & 0x7,
	};
};

const readPackedOperand = (view: DataView, offset: number): DecodedOperand => {
	const word0 = view.getUint32(offset, true);
	const type = (word0 >>> 30) & 0x3;
	const size = SIZE_INDEX_TABLE[(word0 >>> 24) & 0xf];

	switch (type) {
		case 1:
			return { type: 1, size, reg: view.getUint16(offset + 4, true) };
		case 2: {
			const memWord = view.getUint32(offset + 4, true);
			return {
				type: 2,
				size,
				base: (memWord >>> 23) & 0x1ff,
				index: (memWord >>> 14) & 0x1ff,
				scale: SCALE_TABLE[(memWord >>> 12) & 0x3],
				hasDisplacement: ((memWord >>> 11) & 1) !== 0,
				segment: (memWord >>> 8) & 0x7,
				memType: (memWord >>> 6) & 0x3,
				displacement: view.getBigInt64(offset + 8, true),
			};
		}
		case 3:
			return {
				type: 3,
				size,
				segment: view.getUint16(offset + 4, true),
				offset: view.getUint32(offset + 8, true),
			};
		case 4: {
			const flags = view.getUint8(offset + 4);
			return {
				type: 4,
				size,
				isSigned: (flags & 2) !== 0,
				isRelative: (flags & 1) !== 0,
				value: view.getBigInt64(offset + 8, true),
			};
		}
		default:
			return { type: 1, size: 0, reg: 0 };
	}
};

const capBytes = (bytes: Uint8Array): Uint8Array =>
	bytes.byteLength > MAX_INSTRUCTION_LENGTH
		? bytes.subarray(0, MAX_INSTRUCTION_LENGTH)
		: bytes;

export const decodeInstruction = (
	bytes: Uint8Array,
	runtimeAddress: bigint,
): DecodedInstruction | null => {
	if (bytes.byteLength === 0) return null;
	const wasm = WASM_EXPORTS;
	if (!wasm) return null;

	const candidateBytes = capBytes(bytes);
	new Uint8Array(WASM_MEMORY.buffer).set(
		candidateBytes,
		wasm.disassembly_buffer,
	);

	if (wasm.wasm_decode_full(candidateBytes.byteLength, runtimeAddress) < 0)
		return null;

	const view = new DataView(WASM_MEMORY.buffer, wasm.decoded_buffer, 104);
	const header = readPackedHeader(view);

	const decodedOperands: DecodedOperand[] = [];
	for (let i = 0; i < header.operandCount; i++) {
		decodedOperands.push(readPackedOperand(view, 24 + i * 16));
	}

	const prefix = extractPrefix(header.attributes);
	const mnemonicPtr = wasm.wasm_mnemonic_string(header.mnemonic);
	const mnemonic = readCString(
		new Uint8Array(WASM_MEMORY.buffer),
		mnemonicPtr,
		48,
	);
	const operandsStr = formatInstructionOperands(
		header,
		decodedOperands,
		runtimeAddress,
	);

	return {
		length: header.length,
		bytes: candidateBytes.slice(0, header.length),
		mnemonicId: header.mnemonic,
		controlFlow: {
			kind: toControlFlowKind(header.controlFlowKind),
			directTargetAddress: header.hasDirectTarget ? header.directTarget : null,
		},
		prefix,
		mnemonic,
		operands: operandsStr,
		header,
		decodedOperands,
	};
};

export const decodeInstructionLength = (bytes: Uint8Array): number => {
	if (bytes.byteLength === 0) return -1;
	const wasm = WASM_EXPORTS;
	if (!wasm) return -1;

	const candidateBytes = capBytes(bytes);
	new Uint8Array(WASM_MEMORY.buffer).set(
		candidateBytes,
		wasm.disassembly_buffer,
	);

	return wasm.wasm_decode_length(candidateBytes.byteLength);
};
