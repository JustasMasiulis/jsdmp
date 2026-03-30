import { readCString } from "./reader";
import { registerName, ZydisRegister } from "./register";
import { WASM_EXPORTS, WASM_MEMORY } from "./wasm";

export type DecodedInstructionHeader = {
	mnemonic: number;
	length: number;
	operandCount: number;
	controlFlowKind: number;
	hasDirectTarget: boolean;
	encoding: number;
	addressWidth: number;
	operandWidth: number;
	stackWidth: number;
	attributes: bigint;
	directTarget: bigint;
	avxVectorLength: number;
	avxMaskReg: number;
	avxBroadcast: number;
	avxRounding: number;
	avxHasSae: boolean;
	avxMaskMode: number;
};

export type DecodedOperandReg = {
	type: 1;
	size: number;
	reg: number;
};

export type DecodedOperandMem = {
	type: 2;
	size: number;
	base: number;
	index: number;
	scale: number;
	hasDisplacement: boolean;
	displacement: bigint;
	segment: number;
	memType: number;
};

export type DecodedOperandImm = {
	type: 4;
	size: number;
	isSigned: boolean;
	isRelative: boolean;
	value: bigint;
};

export type DecodedOperandPtr = {
	type: 3;
	size: number;
	segment: number;
	offset: number;
};

export type DecodedOperand =
	| DecodedOperandReg
	| DecodedOperandMem
	| DecodedOperandImm
	| DecodedOperandPtr;

const ATTRIB_HAS_LOCK = 1n << 27n;
const ATTRIB_HAS_REP = 1n << 28n;
const ATTRIB_HAS_REPE = 1n << 29n;
const ATTRIB_HAS_REPNE = 1n << 30n;
const ATTRIB_HAS_BND = 1n << 31n;
const ATTRIB_HAS_XACQUIRE = 1n << 32n;
const ATTRIB_HAS_XRELEASE = 1n << 33n;
const ATTRIB_HAS_NOTRACK = 1n << 36n;

const MASK_MODE_ZEROING = 2;
const MASK_MODE_CONTROL_ZEROING = 3;

const SEGMENT_NAMES = ["", "cs", "ss", "ds", "es", "fs", "gs"];

const SIZE_QUALIFIERS: Record<number, string> = {
	8: "byte ptr",
	16: "word ptr",
	32: "dword ptr",
	48: "fword ptr",
	64: "qword ptr",
	80: "tbyte ptr",
	128: "xmmword ptr",
	256: "ymmword ptr",
	512: "zmmword ptr",
};

const BROADCAST_STRINGS: Record<number, string> = {
	1: "{1to2}",
	2: "{1to4}",
	3: "{1to8}",
	4: "{1to16}",
	5: "{1to32}",
	6: "{1to64}",
	7: "{2to4}",
	8: "{2to8}",
	9: "{2to16}",
	10: "{4to8}",
	11: "{4to16}",
	12: "{8to16}",
};

const ROUNDING_STRINGS: Record<number, string> = {
	1: "{rn-sae}",
	2: "{rd-sae}",
	3: "{ru-sae}",
	4: "{rz-sae}",
};

function mnemonicString(id: number): string {
	const wasm = WASM_EXPORTS;
	if (!wasm) return "";
	const ptr = wasm.wasm_mnemonic_string(id);
	return readCString(new Uint8Array(WASM_MEMORY.buffer), ptr, 48);
}

function isStackBase(reg: number): boolean {
	return (
		reg === ZydisRegister.RSP ||
		reg === ZydisRegister.RBP ||
		reg === ZydisRegister.ESP ||
		reg === ZydisRegister.EBP ||
		reg === ZydisRegister.SP ||
		reg === ZydisRegister.BP
	);
}

function defaultSegmentIndex(base: number): number {
	if (isStackBase(base)) return 2; // SS
	return 3; // DS
}

function hexPad(value: bigint, bits: number): string {
	const mask = bits < 64 ? (1n << BigInt(bits)) - 1n : 0xffffffffffffffffn;
	const masked = value & mask;
	const digits = Math.max(2, Math.ceil(bits / 4));
	return "0x" + masked.toString(16).toUpperCase().padStart(digits, "0");
}

function formatSignedHex(value: bigint, bits: number): string {
	const mask = bits < 64 ? (1n << BigInt(bits)) - 1n : 0xffffffffffffffffn;
	const signBit = 1n << BigInt(bits - 1);
	const masked = value & mask;
	if (masked & signBit) {
		const neg = (~masked & mask) + 1n;
		return "-0x" + neg.toString(16).toUpperCase();
	}
	return "0x" + masked.toString(16).toUpperCase();
}

function formatImm(
	op: DecodedOperandImm,
	runtimeAddress: bigint,
	instrLength: number,
): string {
	if (op.isRelative) {
		const target = runtimeAddress + BigInt(instrLength) + op.value;
		const mask = (1n << 64n) - 1n;
		return "0x" + (target & mask).toString(16).toUpperCase();
	}
	if (op.isSigned) {
		return formatSignedHex(op.value, op.size);
	}
	return hexPad(op.value, op.size);
}

function formatMem(op: DecodedOperandMem): string {
	let result = "";

	const isAgen = op.memType === 1;
	if (!isAgen) {
		const qualifier = SIZE_QUALIFIERS[op.size];
		if (qualifier) result += qualifier + " ";
	}

	const segIdx = op.segment;
	if (segIdx > 0 && segIdx !== defaultSegmentIndex(op.base)) {
		result += (SEGMENT_NAMES[segIdx] ?? "") + ":";
	}

	result += "[";

	const hasBase = op.base !== ZydisRegister.NONE;
	const hasIndex = op.index !== ZydisRegister.NONE;
	let bracket = "";

	if (hasBase) {
		bracket = registerName(op.base);
	}

	if (hasIndex) {
		if (bracket.length > 0) bracket += "+";
		const idxName = registerName(op.index);
		bracket += op.scale > 1 ? idxName + "*" + op.scale : idxName;
	}

	if (op.hasDisplacement && op.displacement !== 0n) {
		const isNeg =
			op.displacement < 0n || (op.displacement & (1n << 63n)) !== 0n;
		let absVal: bigint;
		if (op.displacement < 0n) {
			absVal = -op.displacement;
		} else if (op.displacement & (1n << 63n)) {
			absVal = (1n << 64n) - op.displacement;
		} else {
			absVal = op.displacement;
		}
		const hexStr = absVal.toString(16).toUpperCase();
		if (bracket.length > 0) {
			bracket += isNeg ? "-0x" + hexStr : "+0x" + hexStr;
		} else {
			bracket += isNeg ? "-0x" + hexStr : "0x" + hexStr;
		}
	} else if (!hasBase && !hasIndex) {
		const disp = op.displacement & ((1n << 64n) - 1n);
		bracket += "0x" + disp.toString(16).toUpperCase();
	}

	return result + bracket + "]";
}

function formatPtr(op: DecodedOperandPtr): string {
	return (
		"0x" +
		op.segment.toString(16).toUpperCase() +
		":0x" +
		op.offset.toString(16).toUpperCase()
	);
}

function formatOperand(
	op: DecodedOperand,
	runtimeAddress: bigint,
	instrLength: number,
): string {
	switch (op.type) {
		case 1:
			return registerName(op.reg);
		case 2:
			return formatMem(op);
		case 3:
			return formatPtr(op);
		case 4:
			return formatImm(op, runtimeAddress, instrLength);
	}
}

function emitPrefixes(attributes: bigint): string {
	let result = "";
	if (attributes & ATTRIB_HAS_XACQUIRE) result += "xacquire ";
	if (attributes & ATTRIB_HAS_XRELEASE) result += "xrelease ";
	if (attributes & ATTRIB_HAS_LOCK) result += "lock ";
	if (attributes & ATTRIB_HAS_REP) result += "rep ";
	if (attributes & ATTRIB_HAS_REPE) result += "repe ";
	if (attributes & ATTRIB_HAS_REPNE) result += "repne ";
	if (attributes & ATTRIB_HAS_BND) result += "bnd ";
	if (attributes & ATTRIB_HAS_NOTRACK) result += "notrack ";
	return result;
}

function emitAvxDecorators(header: DecodedInstructionHeader): string {
	let result = "";
	if (header.avxMaskReg > 0) {
		result += ` {k${header.avxMaskReg}}`;
		if (
			header.avxMaskMode === MASK_MODE_ZEROING ||
			header.avxMaskMode === MASK_MODE_CONTROL_ZEROING
		) {
			result += " {z}";
		}
	}
	if (header.avxBroadcast > 0) {
		const bc = BROADCAST_STRINGS[header.avxBroadcast];
		if (bc) result += ` ${bc}`;
	}
	if (header.avxRounding > 0) {
		const rnd = ROUNDING_STRINGS[header.avxRounding];
		if (rnd) result += ` ${rnd}`;
	} else if (header.avxHasSae) {
		result += " {sae}";
	}
	return result;
}

export function formatInstruction(
	header: DecodedInstructionHeader,
	operands: DecodedOperand[],
	runtimeAddress: bigint,
): string {
	let result =
		emitPrefixes(header.attributes) + mnemonicString(header.mnemonic);

	const count = Math.min(header.operandCount, operands.length);
	if (count > 0) {
		result += " " + formatOperand(operands[0], runtimeAddress, header.length);
		for (let i = 1; i < count; i++) {
			result +=
				", " + formatOperand(operands[i], runtimeAddress, header.length);
		}
	}
	result += emitAvxDecorators(header);

	return result;
}

export function formatInstructionOperands(
	header: DecodedInstructionHeader,
	operands: DecodedOperand[],
	runtimeAddress: bigint,
): string {
	const count = Math.min(header.operandCount, operands.length);
	if (count === 0) return emitAvxDecorators(header);
	let result = formatOperand(operands[0], runtimeAddress, header.length);
	for (let i = 1; i < count; i++) {
		result += ", " + formatOperand(operands[i], runtimeAddress, header.length);
	}
	result += emitAvxDecorators(header);
	return result;
}
