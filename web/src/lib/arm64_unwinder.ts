import type { Arm64Context } from "./cpu_context";
import { type DebugModule, findModuleForAddress } from "./debug_interface";
import type { MemoryReader } from "./pe";
import { getModulePeFile } from "./symbolServer";
import type { StackFrame, WalkStackResult } from "./unwinder";
import { basename } from "./utils";

// --- ARM64 pdata / xdata types ---

export type Arm64RuntimeFunction = {
	beginAddress: number; // RVA
	unwindData: number; // second DWORD — Flag bits determine format
};

// Compact (packed) pdata field extraction
const PDATA_FLAG_MASK = 0x3;
const PDATA_FUNCTION_LENGTH_SHIFT = 2;
const PDATA_FUNCTION_LENGTH_MASK = 0x7ff;
const PDATA_REGF_SHIFT = 13;
const PDATA_REGF_MASK = 0x7;
const PDATA_REGI_SHIFT = 16;
const PDATA_REGI_MASK = 0xf;
const PDATA_H_SHIFT = 20;
const PDATA_H_MASK = 0x1;
const PDATA_CR_SHIFT = 21;
const PDATA_CR_MASK = 0x3;
const PDATA_FRAME_SIZE_SHIFT = 23;
const PDATA_FRAME_SIZE_MASK = 0x1ff;

// Flag values
const PDATA_REF_TO_FULL_XDATA = 0;
const PDATA_PACKED_UNWIND_FRAGMENT = 2;

// CR values
const PDATA_CR_UNCHAINED_SAVED_LR = 1;
const PDATA_CR_CHAINED_WITH_PAC = 2;
const PDATA_CR_CHAINED = 3;

// xdata header bit positions
const XDATA_FUNCTION_LENGTH_MASK = 0x3ffff;
const XDATA_VERSION_SHIFT = 18;
const XDATA_VERSION_MASK = 0x3;
const XDATA_EPILOG_IN_HEADER_SHIFT = 21;
const XDATA_EPILOG_COUNT_SHIFT = 22;
const XDATA_EPILOG_COUNT_MASK = 0x1f;
const XDATA_CODE_WORDS_SHIFT = 27;
const XDATA_CODE_WORDS_MASK = 0x1f;

// Unwind code size table for opcodes 0xE0-0xFF
const UNWIND_CODE_SIZE_TABLE: readonly number[] = [
	4,
	1,
	2,
	1,
	1,
	1,
	1,
	3, // 0xE0-0xE7
	1,
	1,
	1,
	1,
	1,
	1,
	1,
	1, // 0xE8-0xEF
	1,
	1,
	1,
	1,
	1,
	1,
	1,
	1, // 0xF0-0xF7
	2,
	3,
	4,
	5,
	1,
	1,
	1,
	1, // 0xF8-0xFF
];

// Instruction count table for opcodes 0xE0-0xFF
const UNWIND_CODE_INSTRUCTION_COUNT_TABLE: readonly number[] = [
	1,
	1,
	1,
	1,
	1,
	1,
	1,
	1, // 0xE0-0xE7
	0,
	0,
	0,
	0,
	0,
	0,
	0,
	0, // 0xE8-0xEF
	0,
	0,
	0,
	0,
	0,
	0,
	0,
	0, // 0xF0-0xF7
	1,
	1,
	1,
	1,
	1,
	1,
	1,
	1, // 0xF8-0xFF
];

function opcodeIsEnd(op: number): boolean {
	return (op & 0xfe) === 0xe4;
}

function getUnwindCodeSize(opcode: number): number {
	if (opcode < 0xc0) return 1;
	if (opcode < 0xe0) return 2;
	return UNWIND_CODE_SIZE_TABLE[opcode - 0xe0];
}

function getUnwindCodeInstructionCount(opcode: number): number {
	if (opcode < 0xe0) return 1;
	return UNWIND_CODE_INSTRUCTION_COUNT_TABLE[opcode - 0xe0];
}

// --- Memory helpers ---

async function readQword(reader: MemoryReader, addr: bigint): Promise<bigint> {
	const buf = await reader(addr, 8);
	const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
	return view.getBigUint64(0, true);
}

async function readOword(
	reader: MemoryReader,
	addr: bigint,
): Promise<[bigint, bigint]> {
	const buf = await reader(addr, 16);
	const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
	return [view.getBigUint64(0, true), view.getBigUint64(8, true)];
}

// --- ARM64 pdata binary search (8-byte entries) ---

export async function findArm64RuntimeFunction(
	reader: MemoryReader,
	moduleBase: bigint,
	pdataRva: number,
	pdataSize: number,
	rva: number,
): Promise<Arm64RuntimeFunction | null> {
	const count = Math.floor(pdataSize / 8);
	if (count === 0) return null;

	const raw = await reader(moduleBase + BigInt(pdataRva), pdataSize);
	const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);

	let lo = 0;
	let hi = count - 1;

	while (lo <= hi) {
		const mid = (lo + hi) >>> 1;
		const off = mid * 8;
		const beginAddr = view.getUint32(off, true);
		const unwindData = view.getUint32(off + 4, true);

		// Compute function length from unwind data to determine end address
		const flag = unwindData & PDATA_FLAG_MASK;
		let endAddr: number;
		if (flag === PDATA_REF_TO_FULL_XDATA) {
			// For full xdata, we need to read the function length from xdata header.
			// But for binary search we only need beginAddress ordering.
			// Use next entry's beginAddress as upper bound approximation, or
			// read the xdata for exact length.
			// For binary search: check if rva >= beginAddr.
			// We'll refine the end check below.
			endAddr = beginAddr + 1; // placeholder; refined below
		} else {
			const funcLen =
				(unwindData >>> PDATA_FUNCTION_LENGTH_SHIFT) &
				PDATA_FUNCTION_LENGTH_MASK;
			endAddr = beginAddr + funcLen * 4;
		}

		if (rva < beginAddr) {
			hi = mid - 1;
		} else if (flag !== PDATA_REF_TO_FULL_XDATA && rva >= endAddr) {
			lo = mid + 1;
		} else {
			// For full xdata entries or packed entries where rva is in range,
			// do a precise check
			if (flag === PDATA_REF_TO_FULL_XDATA) {
				// Read the xdata header to get the real function length
				const xdataRva = unwindData & ~3;
				const xdataBuf = await reader(moduleBase + BigInt(xdataRva), 4);
				const xdataView = new DataView(
					xdataBuf.buffer,
					xdataBuf.byteOffset,
					xdataBuf.byteLength,
				);
				const headerWord = xdataView.getUint32(0, true);
				const funcLength = (headerWord & XDATA_FUNCTION_LENGTH_MASK) * 4;
				if (rva >= beginAddr + funcLength) {
					lo = mid + 1;
					continue;
				}
			}
			return { beginAddress: beginAddr, unwindData };
		}
	}

	return null;
}

// --- Register restore helpers ---

async function restoreRegisterRange(
	reader: MemoryReader,
	ctx: Arm64Context,
	spOffset: number,
	firstRegister: number,
	registerCount: number,
): Promise<void> {
	if (firstRegister + registerCount > 31) {
		throw new Error("Invalid register range in unwind data");
	}

	let curAddress = ctx.sp;
	if (spOffset >= 0) {
		curAddress += BigInt(spOffset);
	}

	for (let i = 0; i < registerCount; i++) {
		ctx.setGpr(firstRegister + i, await readQword(reader, curAddress));
		curAddress += 8n;
	}

	if (spOffset < 0) {
		ctx.sp -= BigInt(spOffset); // subtracting negative = adding absolute
	}
}

async function restoreFpRegisterRange(
	reader: MemoryReader,
	ctx: Arm64Context,
	spOffset: number,
	firstRegister: number,
	registerCount: number,
): Promise<void> {
	if (firstRegister + registerCount > 32) {
		throw new Error("Invalid FP register range in unwind data");
	}

	let curAddress = ctx.sp;
	if (spOffset >= 0) {
		curAddress += BigInt(spOffset);
	}

	for (let i = 0; i < registerCount; i++) {
		const lo = await readQword(reader, curAddress);
		// D-register restore: only low 64 bits, high stays zero
		ctx.setSimd(firstRegister + i, lo, 0n);
		curAddress += 8n;
	}

	if (spOffset < 0) {
		ctx.sp -= BigInt(spOffset);
	}
}

async function restoreSimdRegisterRange(
	reader: MemoryReader,
	ctx: Arm64Context,
	spOffset: number,
	firstRegister: number,
	registerCount: number,
): Promise<void> {
	if (firstRegister + registerCount > 32) {
		throw new Error("Invalid SIMD register range in unwind data");
	}

	let curAddress = ctx.sp;
	if (spOffset >= 0) {
		curAddress += BigInt(spOffset);
	}

	for (let i = 0; i < registerCount; i++) {
		const [lo, hi] = await readOword(reader, curAddress);
		ctx.setSimd(firstRegister + i, lo, hi);
		curAddress += 16n;
	}

	if (spOffset < 0) {
		ctx.sp -= BigInt(spOffset);
	}
}

// --- Custom unwind opcodes (trap frame, machine frame, context) ---

// ARM64_KTRAP_FRAME field offsets (Windows SDK, matches FIELD_OFFSET in C++ source)
const KTRAP_FRAME_VFP_STATE = 0x080n;
// Spsr not restored: Arm64Context has no cpsr setter
const _KTRAP_FRAME_SPSR = 0x088n;
const KTRAP_FRAME_SP = 0x090n;
const KTRAP_FRAME_X = 0x098n;
const KTRAP_FRAME_LR = 0x130n; // 0x098 + 19*8
const KTRAP_FRAME_FP = 0x138n;
const KTRAP_FRAME_PC = 0x140n;

// KARM64_VFP_STATE field offsets
const VFP_STATE_FPCR = 0x000n;
const VFP_STATE_FPSR = 0x004n;
const VFP_STATE_V = 0x010n;

async function readDword(reader: MemoryReader, addr: bigint): Promise<number> {
	const buf = await reader(addr, 4);
	const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
	return view.getUint32(0, true);
}

async function unwindCustom(
	reader: MemoryReader,
	ctx: Arm64Context,
	opcode: number,
): Promise<void> {
	const startingSp = ctx.sp;

	switch (opcode) {
		case 0xe8: {
			// Trap frame: restore X0-X18, VfpState (D0-D31), Sp, Lr, Fp, Pc

			// Restore X0-X18
			let srcAddr = startingSp + KTRAP_FRAME_X;
			for (let i = 0; i < 19; i++) {
				ctx.setGpr(i, await readQword(reader, srcAddr));
				srcAddr += 8n;
			}

			// Restore D0-D31 from VfpState if present
			const vfpStateAddr = await readQword(
				reader,
				startingSp + KTRAP_FRAME_VFP_STATE,
			);
			if (vfpStateAddr !== 0n) {
				const fpcr = await readDword(reader, vfpStateAddr + VFP_STATE_FPCR);
				const fpsr = await readDword(reader, vfpStateAddr + VFP_STATE_FPSR);
				if (fpcr !== 0xffffffff && fpsr !== 0xffffffff) {
					srcAddr = vfpStateAddr + VFP_STATE_V;
					for (let i = 0; i < 32; i++) {
						const [lo, hi] = await readOword(reader, srcAddr);
						ctx.setSimd(i, lo, hi);
						srcAddr += 16n;
					}
				}
			}

			// Restore Sp, Lr, Fp, Pc
			ctx.sp = await readQword(reader, startingSp + KTRAP_FRAME_SP);
			ctx.setGpr(30, await readQword(reader, startingSp + KTRAP_FRAME_LR));
			ctx.setGpr(29, await readQword(reader, startingSp + KTRAP_FRAME_FP));
			ctx.ip = await readQword(reader, startingSp + KTRAP_FRAME_PC);
			break;
		}

		case 0xe9: {
			// Machine frame — 16 bytes: SP at offset 0, PC at offset 8
			ctx.sp = await readQword(reader, startingSp);
			ctx.ip = await readQword(reader, startingSp + 8n);
			break;
		}

		case 0xea: {
			// Full context restore — uses ARM64_CONTEXT layout

			// X[0..28] at offset 0x08
			let srcAddr = startingSp + 0x08n;
			for (let i = 0; i < 29; i++) {
				ctx.setGpr(i, await readQword(reader, srcAddr));
				srcAddr += 8n;
			}
			// V[0..31] at offset 0x110
			srcAddr = startingSp + 0x110n;
			for (let i = 0; i < 32; i++) {
				const [lo, hi] = await readOword(reader, srcAddr);
				ctx.setSimd(i, lo, hi);
				srcAddr += 16n;
			}
			// FP at 0xF0, LR at 0xF8, SP at 0x100, PC at 0x108
			ctx.setGpr(29, await readQword(reader, startingSp + 0xf0n));
			ctx.setGpr(30, await readQword(reader, startingSp + 0xf8n));
			ctx.sp = await readQword(reader, startingSp + 0x100n);
			ctx.ip = await readQword(reader, startingSp + 0x108n);
			break;
		}

		case 0xec: {
			// clear_unwound_to_call — set PC from LR
			ctx.ip = ctx.gpr(30);
			break;
		}

		default:
			throw new Error(
				`Unsupported custom unwind opcode: 0x${opcode.toString(16)}`,
			);
	}
}

// --- Compute scope size (prolog/epilog instruction count) ---

export function computeScopeSize(
	codes: Uint8Array,
	offset: number,
	endOffset: number,
	isEpilog: boolean,
): number {
	let scopeSize = 0;
	let ptr = offset;

	while (ptr < endOffset) {
		const opcode = codes[ptr];
		if (opcodeIsEnd(opcode)) break;
		scopeSize += getUnwindCodeInstructionCount(opcode);
		ptr += getUnwindCodeSize(opcode);
	}

	if (isEpilog) scopeSize += 1; // ret instruction
	return scopeSize;
}

// --- Expand compact pdata to full xdata codes ---

export type CompactExpansionResult = {
	codes: Uint8Array;
	epilogInHeader: boolean;
	epilogCount: number;
};

export function expandCompactToFull(
	unwindData: number,
): CompactExpansionResult {
	const flag = unwindData & PDATA_FLAG_MASK;
	const regF = (unwindData >>> PDATA_REGF_SHIFT) & PDATA_REGF_MASK;
	const regI = (unwindData >>> PDATA_REGI_SHIFT) & PDATA_REGI_MASK;
	const h = (unwindData >>> PDATA_H_SHIFT) & PDATA_H_MASK;
	const cr = (unwindData >>> PDATA_CR_SHIFT) & PDATA_CR_MASK;
	const frameSize =
		(unwindData >>> PDATA_FRAME_SIZE_SHIFT) & PDATA_FRAME_SIZE_MASK;

	const famsz = frameSize * 2; // in 8-byte units
	let intsz = regI;
	if (cr === PDATA_CR_UNCHAINED_SAVED_LR) intsz += 1;

	let fpsz = regF;
	if (regF !== 0) fpsz += 1;

	let savsz = intsz + fpsz;
	if (savsz > 0) savsz += h * 8;
	savsz = savsz + (savsz & 1); // align up to 2 (16-byte boundary)

	const locsz = famsz - savsz;

	// Build codes in reverse order, then flip
	const buf: number[] = [];

	// end
	buf.push(0xe4);

	// pac (if chained with PAC)
	if (cr === PDATA_CR_CHAINED_WITH_PAC) buf.push(0xfc);

	let savPredecDone = false;
	let savSlot = 0;

	// Integer register saves
	if (intsz !== 0) {
		// Special case: RegI==1 and CR==UnchainedSavedLr => emit alloc then done
		if (regI === 1 && cr === PDATA_CR_UNCHAINED_SAVED_LR) {
			emitAlloc(buf, savsz * 8);
			savPredecDone = true;
		}

		// Save integer register pairs
		for (let intreg = 0; intreg < Math.floor(regI / 2) * 2; intreg += 2) {
			if (!savPredecDone) {
				emitSaveRegpX(buf, intreg, -savsz * 8);
				savSlot += 2;
				savPredecDone = true;
			} else {
				emitSaveRegp(buf, intreg, savSlot * 8);
				savSlot += 2;
			}
		}

		// Handle odd register count
		if (regI % 2 === 1) {
			const intreg = Math.floor(regI / 2) * 2;
			if (cr === PDATA_CR_UNCHAINED_SAVED_LR) {
				// Save as LR pair
				emitSaveLrpair(buf, intreg, savSlot * 8);
				savSlot += 2;
			} else {
				if (!savPredecDone) {
					emitSaveRegX(buf, intreg, -savsz * 8);
					savSlot += 1;
					savPredecDone = true;
				} else {
					emitSaveReg(buf, intreg, savSlot * 8);
					savSlot += 1;
				}
			}
		} else if (cr === PDATA_CR_UNCHAINED_SAVED_LR) {
			// RegI even, CR==UnchainedSavedLr: save LR separately
			// Register 11 in compact = x30 (LR) in the save_reg encoding (19+11=30)
			if (!savPredecDone) {
				emitSaveRegX(buf, 11, -savsz * 8);
				savSlot += 1;
				savPredecDone = true;
			} else {
				emitSaveReg(buf, 11, savSlot * 8);
				savSlot += 1;
			}
		}
	}

	// Floating-point register saves
	if (fpsz !== 0) {
		for (let fpreg = 0; fpreg < Math.floor(fpsz / 2) * 2; fpreg += 2) {
			if (!savPredecDone) {
				emitSaveFregpX(buf, fpreg, -savsz * 8);
				savSlot += 2;
				savPredecDone = true;
			} else {
				emitSaveFregp(buf, fpreg, savSlot * 8);
				savSlot += 2;
			}
		}

		if (fpsz % 2 === 1) {
			const fpreg = Math.floor(fpsz / 2) * 2;
			if (!savPredecDone) {
				emitSaveFregX(buf, fpreg, -savsz * 8);
				savSlot += 1;
				savPredecDone = true;
			} else {
				emitSaveFreg(buf, fpreg, savSlot * 8);
				savSlot += 1;
			}
		}
	}

	// Home parameter NOPs
	const hasNops = h !== 0 && savPredecDone;
	const nopInsertionPoint = hasNops ? buf.length : -1;
	if (hasNops) {
		buf.push(0xe3, 0xe3, 0xe3, 0xe3);
	}

	// Local area and FP/LR chain
	let fpSet = false;
	if (locsz > 0) {
		if (cr === PDATA_CR_CHAINED || cr === PDATA_CR_CHAINED_WITH_PAC) {
			if (locsz <= 64) {
				emitSaveFplrX(buf, -locsz * 8);
			} else {
				emitAlloc(buf, locsz * 8);
				emitSaveFplr(buf, 0);
			}
			buf.push(0xe1); // set_fp
			fpSet = true;
		} else {
			emitAlloc(buf, locsz * 8);
		}
	}

	// Fragment end marker
	if (flag === PDATA_PACKED_UNWIND_FRAGMENT) {
		buf.push(0xe5); // end_c
	}

	// Compute epilog info matching C++ RtlpExpandCompactToFull:
	// Fragment: no epilog
	// Non-fragment: EpilogInHeader=1, EpilogCount = fpSet ? 1 : 0
	let epilogInHeader: boolean;
	let epilogCount: number;
	if (flag === PDATA_PACKED_UNWIND_FRAGMENT) {
		epilogInHeader = false;
		epilogCount = 0;
	} else {
		epilogInHeader = true;
		epilogCount = fpSet ? 1 : 0;
	}

	// Reverse the buffer so codes are in correct order
	buf.reverse();
	const prologLen = buf.length;

	// Build epilog codes (copy prolog minus nops) for non-fragment functions
	// with homed parameters. Matches the C++ condition:
	//   ops_before_nops != NO_HOME_NOPS && EpilogInHeader != 0
	if (hasNops && epilogInHeader) {
		// After reversal, the NOP bytes (4 of them) which were at
		// nopInsertionPoint..nopInsertionPoint+3 (pre-reversal) are now at
		// (prologLen - nopInsertionPoint - 4)..(prologLen - nopInsertionPoint - 1)
		const nopStart = prologLen - nopInsertionPoint - 4;
		const nopEnd = nopStart + 4;

		for (let i = 0; i < prologLen; i++) {
			if (i >= nopStart && i < nopEnd) continue;
			buf.push(buf[i]);
		}

		epilogCount += prologLen;
	}

	// Pad to 4-byte boundary
	while (buf.length % 4 !== 0) buf.push(0);

	return {
		codes: new Uint8Array(buf),
		epilogInHeader,
		epilogCount,
	};
}

// Compact code emit helpers — bytes are pushed in REVERSE order because the
// entire buffer is reversed after all codes are emitted.  Multi-byte opcodes
// must therefore push their last byte first so that after reversal the opcode
// byte precedes its operand bytes.

function emitAlloc(buf: number[], bytes: number): void {
	const units = Math.floor(bytes / 16);
	if (units <= 0x1f) {
		buf.push(units & 0x1f); // alloc_s (1 byte)
	} else if (units <= 0x7ff) {
		// alloc_m: [opcode_byte, data_byte] -> push reversed
		buf.push(units & 0xff);
		buf.push(0xc0 | ((units >>> 8) & 0x7));
	} else {
		// alloc_l: [0xE0, b1, b2, b3] -> push reversed
		buf.push(units & 0xff);
		buf.push((units >>> 8) & 0xff);
		buf.push((units >>> 16) & 0xff);
		buf.push(0xe0);
	}
}

function emitSaveRegpX(buf: number[], reg: number, offset: number): void {
	const absUnits = Math.floor(-offset / 8) - 1;
	const regBits = reg & 0xf;
	buf.push(((regBits & 0x3) << 6) | (absUnits & 0x3f));
	buf.push(0xcc | ((regBits >>> 2) & 0x3));
}

function emitSaveRegp(buf: number[], reg: number, offset: number): void {
	const units = Math.floor(offset / 8);
	const regBits = reg & 0xf;
	buf.push(((regBits & 0x3) << 6) | (units & 0x3f));
	buf.push(0xc8 | ((regBits >>> 2) & 0x3));
}

function emitSaveRegX(buf: number[], reg: number, offset: number): void {
	const absUnits = Math.floor(-offset / 8) - 1;
	const regBits = reg & 0xf;
	buf.push(((regBits & 0x7) << 5) | (absUnits & 0x1f));
	buf.push(0xd4 | ((regBits >>> 3) & 0x1));
}

function emitSaveReg(buf: number[], reg: number, offset: number): void {
	const units = Math.floor(offset / 8);
	const regBits = reg & 0xf;
	buf.push(((regBits & 0x3) << 6) | (units & 0x3f));
	buf.push(0xd0 | ((regBits >>> 2) & 0x3));
}

function emitSaveLrpair(buf: number[], reg: number, offset: number): void {
	const units = Math.floor(offset / 8);
	const pairIdx = Math.floor(reg / 2);
	buf.push(((pairIdx & 0x3) << 6) | (units & 0x3f));
	buf.push(0xd6 | ((pairIdx >>> 2) & 0x1));
}

function emitSaveFregpX(buf: number[], reg: number, offset: number): void {
	const absUnits = Math.floor(-offset / 8) - 1;
	const regBits = reg & 0x7;
	buf.push(((regBits & 0x3) << 6) | (absUnits & 0x3f));
	buf.push(0xda | ((regBits >>> 2) & 0x1));
}

function emitSaveFregp(buf: number[], reg: number, offset: number): void {
	const units = Math.floor(offset / 8);
	const regBits = reg & 0x7;
	buf.push(((regBits & 0x3) << 6) | (units & 0x3f));
	buf.push(0xd8 | ((regBits >>> 2) & 0x1));
}

function emitSaveFregX(buf: number[], reg: number, offset: number): void {
	const absUnits = Math.floor(-offset / 8) - 1;
	const regBits = reg & 0x7;
	buf.push(((regBits & 0x7) << 5) | (absUnits & 0x1f));
	buf.push(0xde);
}

function emitSaveFreg(buf: number[], reg: number, offset: number): void {
	const units = Math.floor(offset / 8);
	const regBits = reg & 0x7;
	buf.push(((regBits & 0x3) << 6) | (units & 0x3f));
	buf.push(0xdc | ((regBits >>> 2) & 0x1));
}

function emitSaveFplrX(buf: number[], offset: number): void {
	// save_fplr_x: single byte 0x80-0xBF
	const absUnits = Math.floor(-offset / 8) - 1;
	buf.push(0x80 | (absUnits & 0x3f));
}

function emitSaveFplr(buf: number[], offset: number): void {
	// save_fplr: single byte 0x40-0x7F
	const units = Math.floor(offset / 8);
	buf.push(0x40 | (units & 0x3f));
}

// --- Core unwind code execution ---

export async function unwindFunctionFull(
	reader: MemoryReader,
	imageBase: bigint,
	controlPcRva: number,
	functionEntry: Arm64RuntimeFunction,
	ctx: Arm64Context,
	xdataCodes?: Uint8Array | null,
	xdataFunctionLength?: number,
	xdataEpilogCount?: number,
	xdataEpilogInHeader?: boolean,
): Promise<void> {
	let codes: Uint8Array;
	let functionLength: number;
	let epilogCount: number;
	let epilogInHeader: boolean;
	let epilogScopeView: DataView | null = null;

	if (xdataCodes) {
		codes = xdataCodes;
		functionLength = xdataFunctionLength ?? 0;
		epilogCount = xdataEpilogCount ?? 0;
		epilogInHeader = xdataEpilogInHeader ?? false;
	} else {
		const xdataRva = functionEntry.unwindData & ~3;
		const headerBuf = await reader(imageBase + BigInt(xdataRva), 4);
		const headerView = new DataView(
			headerBuf.buffer,
			headerBuf.byteOffset,
			headerBuf.byteLength,
		);
		const headerWord = headerView.getUint32(0, true);

		const version = (headerWord >>> XDATA_VERSION_SHIFT) & XDATA_VERSION_MASK;
		if (version !== 0) {
			throw new Error(`Unsupported ARM64 xdata version: ${version}`);
		}

		functionLength = headerWord & XDATA_FUNCTION_LENGTH_MASK;
		let codeWords =
			(headerWord >>> XDATA_CODE_WORDS_SHIFT) & XDATA_CODE_WORDS_MASK;
		epilogCount =
			(headerWord >>> XDATA_EPILOG_COUNT_SHIFT) & XDATA_EPILOG_COUNT_MASK;
		epilogInHeader = ((headerWord >>> XDATA_EPILOG_IN_HEADER_SHIFT) & 1) !== 0;

		let extraHeaderSize = 0;
		if (epilogCount === 0 && codeWords === 0) {
			const extBuf = await reader(imageBase + BigInt(xdataRva + 4), 4);
			const extView = new DataView(
				extBuf.buffer,
				extBuf.byteOffset,
				extBuf.byteLength,
			);
			const extWord = extView.getUint32(0, true);
			epilogCount = extWord & 0xffff;
			codeWords = (extWord >>> 16) & 0xff;
			extraHeaderSize = 4;
		}

		const epilogScopeSize = epilogInHeader ? 0 : epilogCount * 4;
		const totalDataSize = epilogScopeSize + codeWords * 4;
		const dataBuf = await reader(
			imageBase + BigInt(xdataRva + 4 + extraHeaderSize),
			totalDataSize,
		);

		codes = new Uint8Array(
			dataBuf.buffer,
			dataBuf.byteOffset + epilogScopeSize,
			codeWords * 4,
		);

		if (!epilogInHeader && epilogCount > 0) {
			epilogScopeView = new DataView(
				dataBuf.buffer,
				dataBuf.byteOffset,
				epilogScopeSize,
			);
		}
	}

	const offsetInFunction = Math.floor(
		(controlPcRva - functionEntry.beginAddress) / 4,
	);

	// Check prolog
	const prologSize = computeScopeSize(codes, 0, codes.length, false);
	if (offsetInFunction < prologSize) {
		const skipWords = prologSize - offsetInFunction;
		await executeUnwindCodes(reader, ctx, codes, 0, codes.length, skipWords);
		return;
	}

	// Check single epilog (EpilogInHeader)
	if (epilogInHeader) {
		const unwindIndex = epilogCount;
		const epilogSize = computeScopeSize(codes, unwindIndex, codes.length, true);
		const scopeStart = functionLength - epilogSize;
		if (offsetInFunction >= scopeStart) {
			const skipWords = offsetInFunction - scopeStart;
			await executeUnwindCodes(
				reader,
				ctx,
				codes,
				unwindIndex,
				codes.length,
				skipWords,
			);
			return;
		}
	} else if (epilogScopeView) {
		// Check multiple epilog scopes
		for (let i = 0; i < epilogCount; i++) {
			const scopeWord = epilogScopeView.getUint32(i * 4, true);
			const scopeStart = scopeWord & 0x3ffff;
			const unwindIndex = scopeWord >>> 22;

			if (offsetInFunction < scopeStart) break;

			const epilogSize = computeScopeSize(
				codes,
				unwindIndex,
				codes.length,
				true,
			);
			if (
				offsetInFunction >= scopeStart &&
				offsetInFunction < scopeStart + epilogSize
			) {
				const skipWords = offsetInFunction - scopeStart;
				await executeUnwindCodes(
					reader,
					ctx,
					codes,
					unwindIndex,
					codes.length,
					skipWords,
				);
				return;
			}
		}
	}

	// In function body: execute all codes from the beginning
	await executeUnwindCodes(reader, ctx, codes, 0, codes.length, 0);
}

// --- Execute unwind codes ---

async function executeUnwindCodes(
	reader: MemoryReader,
	ctx: Arm64Context,
	codes: Uint8Array,
	startOffset: number,
	endOffset: number,
	skipWords: number,
): Promise<void> {
	let ptr = startOffset;
	let remaining = skipWords;

	// Skip past instructions we haven't executed yet
	while (ptr < endOffset && remaining > 0) {
		const opcode = codes[ptr];
		if (opcodeIsEnd(opcode)) break;
		ptr += getUnwindCodeSize(opcode);
		remaining--;
	}

	let accumulatedSaveNexts = 0;
	let pcSetByCustom = false;

	while (ptr < endOffset) {
		const curCode = codes[ptr];
		ptr += 1;

		// alloc_s (000xxxxx) — 0x00-0x1F
		if (curCode <= 0x1f) {
			if (accumulatedSaveNexts !== 0) {
				throw new Error("Invalid unwind: save_next before alloc_s");
			}
			ctx.sp += BigInt(16 * (curCode & 0x1f));
		}

		// save_r19r20_x (001zzzzz) — 0x20-0x3F
		else if (curCode <= 0x3f) {
			await restoreRegisterRange(
				reader,
				ctx,
				-8 * (curCode & 0x1f),
				19,
				2 + 2 * accumulatedSaveNexts,
			);
			accumulatedSaveNexts = 0;
		}

		// save_fplr (01zzzzzz) — 0x40-0x7F
		else if (curCode <= 0x7f) {
			if (accumulatedSaveNexts !== 0) {
				throw new Error("Invalid unwind: save_next before save_fplr");
			}
			await restoreRegisterRange(reader, ctx, 8 * (curCode & 0x3f), 29, 2);
		}

		// save_fplr_x (10zzzzzz) — 0x80-0xBF
		else if (curCode <= 0xbf) {
			if (accumulatedSaveNexts !== 0) {
				throw new Error("Invalid unwind: save_next before save_fplr_x");
			}
			await restoreRegisterRange(
				reader,
				ctx,
				-8 * ((curCode & 0x3f) + 1),
				29,
				2,
			);
		}

		// alloc_m (11000xxx|xxxxxxxx) — 0xC0-0xC7
		else if (curCode <= 0xc7) {
			if (accumulatedSaveNexts !== 0) {
				throw new Error("Invalid unwind: save_next before alloc_m");
			}
			const nextByte = codes[ptr];
			ptr += 1;
			ctx.sp += BigInt(16 * (((curCode & 7) << 8) + nextByte));
		}

		// save_regp (110010xx|xxzzzzzz) — 0xC8-0xCB
		else if (curCode <= 0xcb) {
			const nextCode = codes[ptr];
			ptr += 1;
			await restoreRegisterRange(
				reader,
				ctx,
				8 * (nextCode & 0x3f),
				19 + ((curCode & 3) << 2) + (nextCode >>> 6),
				2 + 2 * accumulatedSaveNexts,
			);
			accumulatedSaveNexts = 0;
		}

		// save_regp_x (110011xx|xxzzzzzz) — 0xCC-0xCF
		else if (curCode <= 0xcf) {
			const nextCode = codes[ptr];
			ptr += 1;
			await restoreRegisterRange(
				reader,
				ctx,
				-8 * ((nextCode & 0x3f) + 1),
				19 + ((curCode & 3) << 2) + (nextCode >>> 6),
				2 + 2 * accumulatedSaveNexts,
			);
			accumulatedSaveNexts = 0;
		}

		// save_reg (110100xx|xxzzzzzz) — 0xD0-0xD3
		else if (curCode <= 0xd3) {
			if (accumulatedSaveNexts !== 0) {
				throw new Error("Invalid unwind: save_next before save_reg");
			}
			const nextCode = codes[ptr];
			ptr += 1;
			await restoreRegisterRange(
				reader,
				ctx,
				8 * (nextCode & 0x3f),
				19 + ((curCode & 3) << 2) + (nextCode >>> 6),
				1,
			);
		}

		// save_reg_x (1101010x|xxxzzzzz) — 0xD4-0xD5
		else if (curCode <= 0xd5) {
			if (accumulatedSaveNexts !== 0) {
				throw new Error("Invalid unwind: save_next before save_reg_x");
			}
			const nextCode = codes[ptr];
			ptr += 1;
			await restoreRegisterRange(
				reader,
				ctx,
				-8 * ((nextCode & 0x1f) + 1),
				19 + ((curCode & 1) << 3) + (nextCode >>> 5),
				1,
			);
		}

		// save_lrpair (1101011x|xxzzzzzz) — 0xD6-0xD7
		else if (curCode <= 0xd7) {
			if (accumulatedSaveNexts !== 0) {
				throw new Error("Invalid unwind: save_next before save_lrpair");
			}
			const nextCode = codes[ptr];
			ptr += 1;
			const offset = 8 * (nextCode & 0x3f);
			const reg = 19 + 2 * (((curCode & 1) << 2) + (nextCode >>> 6));
			await restoreRegisterRange(reader, ctx, offset, reg, 1);
			await restoreRegisterRange(reader, ctx, offset + 8, 30, 1);
		}

		// save_fregp (1101100x|xxzzzzzz) — 0xD8-0xD9
		else if (curCode <= 0xd9) {
			const nextCode = codes[ptr];
			ptr += 1;
			await restoreFpRegisterRange(
				reader,
				ctx,
				8 * (nextCode & 0x3f),
				8 + ((curCode & 1) << 2) + (nextCode >>> 6),
				2 + 2 * accumulatedSaveNexts,
			);
			accumulatedSaveNexts = 0;
		}

		// save_fregp_x (1101101x|xxzzzzzz) — 0xDA-0xDB
		else if (curCode <= 0xdb) {
			const nextCode = codes[ptr];
			ptr += 1;
			await restoreFpRegisterRange(
				reader,
				ctx,
				-8 * ((nextCode & 0x3f) + 1),
				8 + ((curCode & 1) << 2) + (nextCode >>> 6),
				2 + 2 * accumulatedSaveNexts,
			);
			accumulatedSaveNexts = 0;
		}

		// save_freg (1101110x|xxzzzzzz) — 0xDC-0xDD
		else if (curCode <= 0xdd) {
			if (accumulatedSaveNexts !== 0) {
				throw new Error("Invalid unwind: save_next before save_freg");
			}
			const nextCode = codes[ptr];
			ptr += 1;
			await restoreFpRegisterRange(
				reader,
				ctx,
				8 * (nextCode & 0x3f),
				8 + ((curCode & 1) << 2) + (nextCode >>> 6),
				1,
			);
		}

		// save_freg_x (11011110|xxxzzzzz) — 0xDE
		else if (curCode === 0xde) {
			if (accumulatedSaveNexts !== 0) {
				throw new Error("Invalid unwind: save_next before save_freg_x");
			}
			const nextCode = codes[ptr];
			ptr += 1;
			await restoreFpRegisterRange(
				reader,
				ctx,
				-8 * ((nextCode & 0x1f) + 1),
				8 + (nextCode >>> 5),
				1,
			);
		}

		// alloc_l (11100000|xxx|xxx|xxx) — 0xE0
		else if (curCode === 0xe0) {
			if (accumulatedSaveNexts !== 0) {
				throw new Error("Invalid unwind: save_next before alloc_l");
			}
			const b1 = codes[ptr];
			const b2 = codes[ptr + 1];
			const b3 = codes[ptr + 2];
			ptr += 3;
			ctx.sp += BigInt(16 * ((b1 << 16) | (b2 << 8) | b3));
		}

		// set_fp (11100001) — 0xE1
		else if (curCode === 0xe1) {
			if (accumulatedSaveNexts !== 0) {
				throw new Error("Invalid unwind: save_next before set_fp");
			}
			ctx.sp = ctx.gpr(29); // SP = FP
		}

		// add_fp (11100010|xxxxxxxx) — 0xE2
		else if (curCode === 0xe2) {
			if (accumulatedSaveNexts !== 0) {
				throw new Error("Invalid unwind: save_next before add_fp");
			}
			const nextByte = codes[ptr];
			ptr += 1;
			ctx.sp = ctx.gpr(29) - BigInt(8 * nextByte);
		}

		// nop (11100011) — 0xE3
		else if (curCode === 0xe3) {
			if (accumulatedSaveNexts !== 0) {
				throw new Error("Invalid unwind: save_next before nop");
			}
			// Nothing to do
		}

		// end (11100100) — 0xE4
		else if (curCode === 0xe4) {
			if (accumulatedSaveNexts !== 0) {
				throw new Error("Invalid unwind: save_next before end");
			}
			break;
		}

		// end_c (11100101) — 0xE5
		else if (curCode === 0xe5) {
			// End of chained scope — continue
		}

		// save_next_pair (11100110) — 0xE6
		else if (curCode === 0xe6) {
			accumulatedSaveNexts += 1;
		}

		// Extended register save (11100111|0pxrrrrr|ffoooooo) — 0xE7
		else if (curCode === 0xe7) {
			const val2 = codes[ptr];
			const val1 = codes[ptr + 1];
			ptr += 2;

			// Decode bitfields from the 16-bit value (val2 is high byte, val1 is low byte)
			const combined = (val2 << 8) | val1;
			const o = combined & 0x3f;
			const f = (combined >>> 6) & 0x3;
			const r = (combined >>> 8) & 0x1f;
			const x = (combined >>> 13) & 0x1;
			const p = (combined >>> 14) & 0x1;
			const fixed = (combined >>> 15) & 0x1;

			if (p === 0 && accumulatedSaveNexts !== 0) {
				throw new Error("Invalid unwind: save_next before non-pair E7 opcode");
			}
			if (fixed !== 0) {
				throw new Error("Invalid unwind: fixed bit set in E7 opcode");
			}

			let spOffset = o + x;
			spOffset *= x === 1 || f === 2 || p === 1 ? 16 : 8;
			if (x === 1) spOffset = -spOffset;

			const regCount = 1 + p + 2 * accumulatedSaveNexts;

			if (f === 0) {
				await restoreRegisterRange(reader, ctx, spOffset, r, regCount);
			} else if (f === 1) {
				await restoreFpRegisterRange(reader, ctx, spOffset, r, regCount);
			} else if (f === 2) {
				await restoreSimdRegisterRange(reader, ctx, spOffset, r, regCount);
			} else {
				throw new Error("Invalid unwind: unknown format in E7 opcode");
			}

			accumulatedSaveNexts = 0;
		}

		// Custom opcodes: trap_frame, machine_frame, context, clear_unwound_to_call
		else if (curCode >= 0xe8 && curCode <= 0xec) {
			if (accumulatedSaveNexts !== 0) {
				throw new Error("Invalid unwind: save_next before custom opcode");
			}
			await unwindCustom(reader, ctx, curCode);
			pcSetByCustom = true;
		}

		// pac (11111100) — 0xFC
		else if (curCode === 0xfc) {
			if (accumulatedSaveNexts !== 0) {
				throw new Error("Invalid unwind: save_next before pac");
			}
			// Strip PAC bits from LR (XPACI equivalent). On Windows ARM64,
			// user VA is 47 bits; PAC uses bits 47+ for the auth code.
			ctx.setGpr(30, ctx.gpr(30) & 0x00007fffffffffffn);
		}

		// Reserved/future opcodes (0xF8-0xFF, excluding 0xFC=pac handled above)
		else if (curCode >= 0xf8) {
			if (accumulatedSaveNexts !== 0) {
				throw new Error("Invalid unwind: save_next before reserved opcode");
			}
			// 0xF8-0xFB: skip variable extra bytes; 0xFD-0xFF: 1-byte NOPs
			if (curCode <= 0xfb) {
				ptr += 1 + (curCode & 0x3);
			}
		}

		// Unknown/unsupported (0xDF, 0xED-0xF7)
		else {
			throw new Error(
				`Unsupported ARM64 unwind opcode: 0x${curCode.toString(16)}`,
			);
		}
	}

	// Set PC from LR unless a custom opcode already set it
	if (!pcSetByCustom) {
		ctx.ip = ctx.gpr(30);
	}
}

// --- Compact format unwinding ---

async function unwindFunctionCompact(
	reader: MemoryReader,
	imageBase: bigint,
	controlPcRva: number,
	functionEntry: Arm64RuntimeFunction,
	ctx: Arm64Context,
): Promise<void> {
	const unwindData = functionEntry.unwindData;
	const funcLengthInInstructions =
		(unwindData >>> PDATA_FUNCTION_LENGTH_SHIFT) & PDATA_FUNCTION_LENGTH_MASK;

	const { codes, epilogInHeader, epilogCount } =
		expandCompactToFull(unwindData);

	await unwindFunctionFull(
		reader,
		imageBase,
		controlPcRva,
		functionEntry,
		ctx,
		codes,
		funcLengthInInstructions,
		epilogCount,
		epilogInHeader,
	);
}

// --- Main entry point ---

export async function arm64VirtualUnwind(
	reader: MemoryReader,
	imageBase: bigint,
	controlPc: bigint,
	runtimeFunction: Arm64RuntimeFunction,
	ctx: Arm64Context,
): Promise<void> {
	const unwindType = runtimeFunction.unwindData & 3;
	let entry = runtimeFunction;
	let controlPcRva = Number(controlPc - imageBase);

	// Handle chained entry (type 3)
	if (unwindType === 3) {
		const chainedRva = runtimeFunction.unwindData & ~3;
		const chainBuf = await reader(imageBase + BigInt(chainedRva), 8);
		const chainView = new DataView(
			chainBuf.buffer,
			chainBuf.byteOffset,
			chainBuf.byteLength,
		);
		entry = {
			beginAddress: chainView.getUint32(0, true),
			unwindData: chainView.getUint32(4, true),
		};
		controlPcRva = entry.beginAddress;
	}

	const flag = entry.unwindData & PDATA_FLAG_MASK;

	if (flag === PDATA_REF_TO_FULL_XDATA) {
		await unwindFunctionFull(reader, imageBase, controlPcRva, entry, ctx);
	} else {
		await unwindFunctionCompact(reader, imageBase, controlPcRva, entry, ctx);
	}
}

// --- Stack walking ---

export async function arm64WalkStack(
	reader: MemoryReader,
	modules: DebugModule[],
	initialContext: Arm64Context,
	maxFrames = 64,
): Promise<WalkStackResult> {
	const frames: StackFrame[] = [];
	const ctx = initialContext.clone();

	for (let i = 0; i < maxFrames; i++) {
		if (ctx.ip === 0n) break;

		const mod = findModuleForAddress(ctx.ip, modules);
		frames.push({
			ip: ctx.ip,
			sp: ctx.sp,
			moduleName: mod ? basename(mod.path) : "<unknown>",
			moduleBase: mod?.address ?? 0n,
			offset: mod ? ctx.ip - mod.address : ctx.ip,
		});

		const prevIp = ctx.ip;

		try {
			if (mod) {
				const rva = Number(ctx.ip - mod.address);
				const pe = await getModulePeFile(mod);

				let entry: Arm64RuntimeFunction | null = null;
				if (pe) {
					const exc = pe.directories[3]; // EXCEPTION_DIRECTORY_INDEX
					if (exc && exc.address !== 0 && exc.size !== 0) {
						entry = await findArm64RuntimeFunction(
							reader,
							mod.address,
							exc.address,
							exc.size,
							rva,
						);
					}
				}

				if (entry) {
					await arm64VirtualUnwind(reader, mod.address, ctx.ip, entry, ctx);
				} else {
					// Leaf function: PC = LR
					ctx.ip = ctx.gpr(30);
				}
			} else {
				// No module: treat as leaf
				ctx.ip = ctx.gpr(30);
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return { frames, error: msg };
		}

		if (ctx.ip === prevIp) break;
	}

	return { frames };
}
