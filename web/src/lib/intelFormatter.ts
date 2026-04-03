/** biome-ignore-all lint/style/useTemplate: string concatenation has better performance */
import { readCString } from "./reader";
import { registerName, ZydisRegister } from "./register";
import { WASM_EXPORTS, WASM_MEMORY } from "./wasm";

export type InstrSyntaxKind =
	| "plain"
	| "mnemonic"
	| "number"
	| "register"
	| "keyword";

export type InstrTextSegment = {
	text: string;
	syntaxKind: InstrSyntaxKind;
};

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

export const seg = (
	text: string,
	syntaxKind: InstrSyntaxKind = "plain",
): InstrTextSegment => ({ text, syntaxKind });

function formatImmSegments(
	op: DecodedOperandImm,
	runtimeAddress: bigint,
	instrLength: number,
): InstrTextSegment[] {
	if (op.isRelative) {
		const target = runtimeAddress + BigInt(instrLength) + op.value;
		const mask = (1n << 64n) - 1n;
		return [seg("0x" + (target & mask).toString(16).toUpperCase(), "number")];
	}
	if (op.isSigned) {
		return [seg(formatSignedHex(op.value, op.size), "number")];
	}
	return [seg(hexPad(op.value, op.size), "number")];
}

function formatMemSegments(op: DecodedOperandMem): InstrTextSegment[] {
	const out: InstrTextSegment[] = [];

	const isAgen = op.memType === 1;
	if (!isAgen) {
		const qualifier = SIZE_QUALIFIERS[op.size];
		if (qualifier) {
			out.push(seg(qualifier, "keyword"));
			out.push(seg(" "));
		}
	}

	const segIdx = op.segment;
	if (segIdx > 0 && segIdx !== defaultSegmentIndex(op.base)) {
		out.push(seg(SEGMENT_NAMES[segIdx] ?? "", "register"));
		out.push(seg(":"));
	}

	out.push(seg("["));

	const hasBase = op.base !== ZydisRegister.NONE;
	const hasIndex = op.index !== ZydisRegister.NONE;

	if (hasBase) {
		out.push(seg(registerName(op.base), "register"));
	}

	if (hasIndex) {
		if (hasBase) out.push(seg("+"));
		out.push(seg(registerName(op.index), "register"));
		if (op.scale > 1) {
			out.push(seg("*"));
			out.push(seg(String(op.scale), "number"));
		}
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
		if (hasBase || hasIndex) {
			out.push(seg(isNeg ? "-" : "+"));
			out.push(seg("0x" + hexStr, "number"));
		} else {
			out.push(seg((isNeg ? "-0x" : "0x") + hexStr, "number"));
		}
	} else if (!hasBase && !hasIndex) {
		const disp = op.displacement & ((1n << 64n) - 1n);
		out.push(seg("0x" + disp.toString(16).toUpperCase(), "number"));
	}

	out.push(seg("]"));
	return out;
}

function formatPtrSegments(op: DecodedOperandPtr): InstrTextSegment[] {
	return [
		seg("0x" + op.segment.toString(16).toUpperCase(), "number"),
		seg(":"),
		seg("0x" + op.offset.toString(16).toUpperCase(), "number"),
	];
}

function formatOperandSegments(
	op: DecodedOperand,
	runtimeAddress: bigint,
	instrLength: number,
): InstrTextSegment[] {
	switch (op.type) {
		case 1:
			return [seg(registerName(op.reg), "register")];
		case 2:
			return formatMemSegments(op);
		case 3:
			return formatPtrSegments(op);
		case 4:
			return formatImmSegments(op, runtimeAddress, instrLength);
	}
}

function emitPrefixSegments(attributes: bigint): InstrTextSegment[] {
	const out: InstrTextSegment[] = [];
	if (attributes & ATTRIB_HAS_XACQUIRE) out.push(seg("xacquire ", "mnemonic"));
	if (attributes & ATTRIB_HAS_XRELEASE) out.push(seg("xrelease ", "mnemonic"));
	if (attributes & ATTRIB_HAS_LOCK) out.push(seg("lock ", "mnemonic"));
	if (attributes & ATTRIB_HAS_REP) out.push(seg("rep ", "mnemonic"));
	if (attributes & ATTRIB_HAS_REPE) out.push(seg("repe ", "mnemonic"));
	if (attributes & ATTRIB_HAS_REPNE) out.push(seg("repne ", "mnemonic"));
	if (attributes & ATTRIB_HAS_BND) out.push(seg("bnd ", "mnemonic"));
	if (attributes & ATTRIB_HAS_NOTRACK) out.push(seg("notrack ", "mnemonic"));
	return out;
}

function emitAvxDecoratorSegments(
	header: DecodedInstructionHeader,
): InstrTextSegment[] {
	const out: InstrTextSegment[] = [];
	if (header.avxMaskReg > 0) {
		out.push(seg(` {k${header.avxMaskReg}}`, "keyword"));
		if (
			header.avxMaskMode === MASK_MODE_ZEROING ||
			header.avxMaskMode === MASK_MODE_CONTROL_ZEROING
		) {
			out.push(seg(" {z}", "keyword"));
		}
	}
	if (header.avxBroadcast > 0) {
		const bc = BROADCAST_STRINGS[header.avxBroadcast];
		if (bc) out.push(seg(` ${bc}`, "keyword"));
	}
	if (header.avxRounding > 0) {
		const rnd = ROUNDING_STRINGS[header.avxRounding];
		if (rnd) out.push(seg(` ${rnd}`, "keyword"));
	} else if (header.avxHasSae) {
		out.push(seg(" {sae}", "keyword"));
	}
	return out;
}

export const joinSegmentText = (
	segments: readonly { text: string }[],
): string => {
	let result = "";
	for (const s of segments) result += s.text;
	return result;
};

export function formatInstructionOperandsSegments(
	header: DecodedInstructionHeader,
	operands: DecodedOperand[],
	runtimeAddress: bigint,
): InstrTextSegment[] {
	const count = Math.min(header.operandCount, operands.length);
	if (count === 0) return emitAvxDecoratorSegments(header);
	const out: InstrTextSegment[] = formatOperandSegments(
		operands[0],
		runtimeAddress,
		header.length,
	);
	for (let i = 1; i < count; i++) {
		out.push(seg(", "));
		out.push(
			...formatOperandSegments(operands[i], runtimeAddress, header.length),
		);
	}
	out.push(...emitAvxDecoratorSegments(header));
	return out;
}

export function formatInstructionSegments(
	header: DecodedInstructionHeader,
	operands: DecodedOperand[],
	runtimeAddress: bigint,
): InstrTextSegment[] {
	const out: InstrTextSegment[] = emitPrefixSegments(header.attributes);
	out.push(seg(mnemonicString(header.mnemonic), "mnemonic"));

	const operandSegs = formatInstructionOperandsSegments(
		header,
		operands,
		runtimeAddress,
	);
	if (operandSegs.length > 0) {
		out.push(seg(" "));
		out.push(...operandSegs);
	}
	return out;
}

export function formatInstruction(
	header: DecodedInstructionHeader,
	operands: DecodedOperand[],
	runtimeAddress: bigint,
): string {
	return joinSegmentText(
		formatInstructionSegments(header, operands, runtimeAddress),
	);
}
