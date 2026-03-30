import type { Context } from "./cpu_context";
import { type DebugModule, findModuleForAddress } from "./debug_interface";
import {
	type MemoryReader,
	type PeFile,
	type RuntimeFunction,
	readUnwindInfo,
	UNW_FLAG_CHAININFO,
	type UnwindCode,
	type UnwindInfo,
} from "./pe";
import { getModulePeFile } from "./symbolServer";
import { basename } from "./utils";

// --- Constants ---
const UNWIND_CHAIN_LIMIT = 32;

const UWOP_PUSH_NONVOL = 0;
const UWOP_ALLOC_LARGE = 1;
const UWOP_ALLOC_SMALL = 2;
const UWOP_SET_FPREG = 3;
const UWOP_SAVE_NONVOL = 4;
const UWOP_SAVE_NONVOL_FAR = 5;
const UWOP_EPILOG = 6;
// const UWOP_SPARE_CODE = 7;
const UWOP_SAVE_XMM128 = 8;
const UWOP_SAVE_XMM128_FAR = 9;
const UWOP_PUSH_MACHFRAME = 10;

const SIZE64_PREFIX = 0x48;
const ADD_IMM8_OP = 0x83;
const ADD_IMM32_OP = 0x81;
const JMP_IMM8_OP = 0xeb;
const JMP_IMM32_OP = 0xe9;
const JMP_IND_OP = 0xff;
const LEA_OP = 0x8d;
const REPNE_PREFIX = 0xf2;
const REP_PREFIX = 0xf3;
const POP_OP = 0x58;
const RET_OP = 0xc3;
const RET_OP_2 = 0xc2;

const UNWIND_OP_EXTRA_SLOT_TABLE = [0, 1, 0, 0, 1, 2, 1, 2, 1, 2, 0];

// --- Helpers ---

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

function unwindOpSlots(code: UnwindCode): number {
	const extra = UNWIND_OP_EXTRA_SLOT_TABLE[code.unwindOp] ?? 0;
	if (code.unwindOp === UWOP_ALLOC_LARGE && code.opInfo !== 0) {
		return 1 + extra + 1; // 3 slots total
	}
	return 1 + extra;
}

function slotU16(codes: UnwindCode[], idx: number): number {
	return codes[idx].frameOffset;
}

function slotU32(codes: UnwindCode[], idx: number): number {
	return ((codes[idx + 1].frameOffset << 16) | codes[idx].frameOffset) >>> 0;
}

// --- Prologue unwinding ---

async function unwindPrologue(
	reader: MemoryReader,
	imageBase: bigint,
	controlPc: bigint,
	functionEntry: RuntimeFunction,
	ctx: Context,
	initialInfo?: UnwindInfo | null,
): Promise<void> {
	let entry: RuntimeFunction | null = functionEntry;
	let chainDepth = 0;
	let info = initialInfo ?? null;

	while (entry) {
		if (chainDepth++ > UNWIND_CHAIN_LIMIT) break;

		if (!info) {
			info = await readUnwindInfo(reader, imageBase, entry.unwindInfoAddress);
		}
		if (!info) break;

		const prologOffset = Number(controlPc - imageBase) - entry.beginAddress;

		// Determine frame base — mirrors the EstablisherFrame logic in the
		// reference: when in the prolog, only use the frame register if
		// UWOP_SET_FPREG has already been executed.
		let frameBase: bigint;
		if (info.frameRegister === 0) {
			frameBase = ctx.sp;
		} else if (
			prologOffset >= info.sizeOfProlog ||
			(info.flags & UNW_FLAG_CHAININFO) !== 0
		) {
			frameBase =
				ctx.gpr(info.frameRegister) - BigInt(info.frameOffset * 16);
		} else {
			// In prolog: scan for SET_FPREG to see if it's been executed
			let setFpregOffset = -1;
			let j = 0;
			while (j < info.countOfUnwindCodes) {
				if (info.unwindCodes[j].unwindOp === UWOP_SET_FPREG) {
					setFpregOffset = info.unwindCodes[j].codeOffset;
					break;
				}
				j += unwindOpSlots(info.unwindCodes[j]);
			}
			if (setFpregOffset >= 0 && prologOffset >= setFpregOffset) {
				frameBase =
					ctx.gpr(info.frameRegister) - BigInt(info.frameOffset * 16);
			} else {
				frameBase = ctx.sp;
			}
		}

		let i = 0;
		while (i < info.countOfUnwindCodes) {
			const code = info.unwindCodes[i];
			const slots = unwindOpSlots(code);

			// In the prolog: only process codes we've already executed
			if (prologOffset >= code.codeOffset) {
				switch (code.unwindOp) {
					case UWOP_PUSH_NONVOL:
						ctx.setGpr(code.opInfo, await readQword(reader, ctx.sp));
						ctx.sp += 8n;
						break;

					case UWOP_ALLOC_LARGE:
						if (code.opInfo === 0) {
							ctx.sp += BigInt(slotU16(info.unwindCodes, i + 1) * 8);
						} else {
							ctx.sp += BigInt(slotU32(info.unwindCodes, i + 1));
						}
						break;

					case UWOP_ALLOC_SMALL:
						ctx.sp += BigInt(code.opInfo * 8 + 8);
						break;

					case UWOP_SET_FPREG:
						ctx.sp =
							ctx.gpr(info.frameRegister) - BigInt(info.frameOffset * 16);
						break;

					case UWOP_SAVE_NONVOL: {
						const offset = BigInt(slotU16(info.unwindCodes, i + 1) * 8);
						ctx.setGpr(
							code.opInfo,
							await readQword(reader, frameBase + offset),
						);
						break;
					}

					case UWOP_SAVE_NONVOL_FAR: {
						const offset = BigInt(slotU32(info.unwindCodes, i + 1));
						ctx.setGpr(
							code.opInfo,
							await readQword(reader, frameBase + offset),
						);
						break;
					}

					case UWOP_EPILOG:
						// Version 2 epilog marker — skip
						break;

					case UWOP_SAVE_XMM128: {
						const offset = BigInt(
							slotU16(info.unwindCodes, i + 1) * 16,
						);
						const [lo, hi] = await readOword(
							reader,
							frameBase + offset,
						);
						ctx.setXmm(code.opInfo, lo, hi);
						break;
					}

					case UWOP_SAVE_XMM128_FAR: {
						const offset = BigInt(slotU32(info.unwindCodes, i + 1));
						const [lo, hi] = await readOword(
							reader,
							frameBase + offset,
						);
						ctx.setXmm(code.opInfo, lo, hi);
						break;
					}

					case UWOP_PUSH_MACHFRAME: {
						const hasPushError = code.opInfo !== 0;
						const base = ctx.sp + (hasPushError ? 8n : 0n);
						ctx.ip = await readQword(reader, base);
						ctx.sp = await readQword(reader, base + 24n);
						return; // Machine frame sets RIP directly
					}
				}
			}

			i += slots;
		}

		// Follow chain if present
		if (info.flags & UNW_FLAG_CHAININFO && info.chainedFunctionEntry) {
			entry = info.chainedFunctionEntry;
			info = null; // Force re-read for chained entry
			controlPc = imageBase + BigInt(entry.endAddress);
		} else {
			entry = null;
		}
	}

	// Read return address from stack
	ctx.ip = await readQword(reader, ctx.sp);
	ctx.sp += 8n;
}

// --- Epilogue detection and unwinding ---

function isInEpilogue(
	buf: Uint8Array,
	controlPcRva: number,
	functionEntry: RuntimeFunction,
	info: UnwindInfo,
): boolean {
	let i = 0;

	// Check for add rsp, imm8 (48 83 c4 xx)
	if (
		buf[i] === SIZE64_PREFIX &&
		buf[i + 1] === ADD_IMM8_OP &&
		buf[i + 2] === 0xc4
	) {
		i += 4;
	}
	// Check for add rsp, imm32 (48 81 c4 xx xx xx xx)
	else if (
		buf[i] === SIZE64_PREFIX &&
		buf[i + 1] === ADD_IMM32_OP &&
		buf[i + 2] === 0xc4
	) {
		i += 7;
	}
	// Check for lea rsp, disp[fp] — REX.W or REX.WB prefix
	else if ((buf[i] & 0xfe) === SIZE64_PREFIX && buf[i + 1] === LEA_OP) {
		const frameRegister =
			((buf[i] & 0x1) << 3) | (buf[i + 2] & 0x07);
		if (
			frameRegister !== 0 &&
			frameRegister === info.frameRegister
		) {
			if ((buf[i + 2] & 0xf8) === 0x60) {
				i += 4; // disp8
			} else if ((buf[i + 2] & 0xf8) === 0xa0) {
				i += 7; // disp32
			}
		}
	}

	// Pop sequence: any REX prefix + pop
	while (i < buf.length) {
		if ((buf[i] & 0xf8) === POP_OP) {
			i += 1;
		} else if (
			(buf[i] & 0xf0) === 0x40 &&
			(buf[i + 1] & 0xf8) === POP_OP
		) {
			i += 2;
		} else {
			break;
		}
	}

	if (i >= buf.length) return false;

	// REPNE prefix may precede control transfer
	if (buf[i] === REPNE_PREFIX) {
		i += 1;
	}

	// ret / ret imm16
	if (buf[i] === RET_OP || buf[i] === RET_OP_2) return true;
	// rep ret
	if (buf[i] === REP_PREFIX && buf[i + 1] === RET_OP) return true;

	// jmp rel8 / jmp rel32 — must target outside this function
	if (buf[i] === JMP_IMM8_OP || buf[i] === JMP_IMM32_OP) {
		let branchTarget = controlPcRva + i;
		if (buf[i] === JMP_IMM8_OP) {
			const rel = buf[i + 1];
			branchTarget += 2 + (rel > 127 ? rel - 256 : rel);
		} else {
			const view = new DataView(
				buf.buffer,
				buf.byteOffset,
				buf.byteLength,
			);
			branchTarget += 5 + view.getInt32(i + 1, true);
		}
		if (
			branchTarget < functionEntry.beginAddress ||
			branchTarget >= functionEntry.endAddress
		) {
			return true;
		}
		if (branchTarget === functionEntry.beginAddress) {
			return true;
		}
		return false;
	}

	// jmp [rip+disp32] (ff 25) — indirect jump to import
	if (buf[i] === JMP_IND_OP && buf[i + 1] === 0x25) return true;

	// rex jmp [reg] — (REX.W variants) ff /4
	if (
		(buf[i] & 0xf8) === SIZE64_PREFIX &&
		buf[i + 1] === JMP_IND_OP &&
		(buf[i + 2] & 0x38) === 0x20
	) {
		return true;
	}

	return false;
}

async function emulateEpilogue(
	reader: MemoryReader,
	controlPc: bigint,
	ctx: Context,
): Promise<void> {
	const buf = await reader(controlPc, 32);
	return emulateEpilogueCore(buf, ctx, reader);
}

async function emulateEpilogueCore(
	buf: Uint8Array,
	ctx: Context,
	reader: MemoryReader,
): Promise<void> {
	const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
	let i = 0;

	if ((buf[i] & 0xf8) === SIZE64_PREFIX) {
		if (buf[i + 1] === ADD_IMM8_OP) {
			// add rsp, imm8
			ctx.sp += BigInt(buf[i + 3]);
			i += 4;
		} else if (buf[i + 1] === ADD_IMM32_OP) {
			// add rsp, imm32
			const disp =
				buf[i + 3] |
				(buf[i + 4] << 8) |
				(buf[i + 5] << 16) |
				(buf[i + 6] << 24);
			ctx.sp += BigInt(disp);
			i += 7;
		} else if (buf[i + 1] === LEA_OP) {
			// lea rsp, disp[fp] — combine REX.B with rm for source register
			const srcReg = ((buf[i] & 0x1) << 3) | (buf[i + 2] & 0x07);
			if ((buf[i + 2] & 0xf8) === 0x60) {
				const disp = buf[i + 3];
				const signedDisp = disp > 127 ? disp - 256 : disp;
				ctx.sp = ctx.gpr(srcReg) + BigInt(signedDisp);
				i += 4;
			} else if ((buf[i + 2] & 0xf8) === 0xa0) {
				const disp =
					buf[i + 3] |
					(buf[i + 4] << 8) |
					(buf[i + 5] << 16) |
					(buf[i + 6] << 24);
				ctx.sp = ctx.gpr(srcReg) + BigInt(disp);
				i += 7;
			}
		}
	}

	// Pop sequence — accept any REX prefix
	while (i < buf.length) {
		if ((buf[i] & 0xf8) === POP_OP) {
			const reg = buf[i] & 0x07;
			ctx.setGpr(reg, await readQword(reader, ctx.sp));
			ctx.sp += 8n;
			i += 1;
		} else if (
			(buf[i] & 0xf0) === 0x40 &&
			(buf[i + 1] & 0xf8) === POP_OP
		) {
			const reg = ((buf[i] & 1) << 3) | (buf[i + 1] & 0x07);
			ctx.setGpr(reg, await readQword(reader, ctx.sp));
			ctx.sp += 8n;
			i += 2;
		} else {
			break;
		}
	}

	// All terminal instructions emulate a return
	ctx.ip = await readQword(reader, ctx.sp);
	ctx.sp += 8n;
}

function isInEpilogueV2(
	controlPc: bigint,
	imageBase: bigint,
	functionEntry: RuntimeFunction,
	info: UnwindInfo,
): boolean {
	if (info.countOfUnwindCodes === 0) return false;

	const firstCode = info.unwindCodes[0];
	if (firstCode.unwindOp !== UWOP_EPILOG) return false;

	const relativePc = Number(controlPc - imageBase);
	const epilogSize = firstCode.codeOffset;

	// First UWOP_EPILOG: if low bit of opInfo set, epilogue at function end
	if (firstCode.opInfo & 0x01) {
		const epilogStart = functionEntry.endAddress - epilogSize;
		if (relativePc - epilogStart >= 0 && relativePc - epilogStart < epilogSize) {
			return true;
		}
	}

	// Subsequent UWOP_EPILOG codes: offset is distance from function end
	for (let i = 1; i < info.countOfUnwindCodes; i++) {
		const code = info.unwindCodes[i];
		if (code.unwindOp !== UWOP_EPILOG) break;

		const distFromEnd = (code.opInfo << 8) | code.codeOffset;
		if (distFromEnd === 0) break;

		const epilogStart = functionEntry.endAddress - distFromEnd;
		if (relativePc - epilogStart >= 0 && relativePc - epilogStart < epilogSize) {
			return true;
		}
	}

	return false;
}

// --- Main virtual unwind ---

export async function virtualUnwind(
	reader: MemoryReader,
	imageBase: bigint,
	controlPc: bigint,
	functionEntry: RuntimeFunction,
	ctx: Context,
): Promise<void> {
	const info = await readUnwindInfo(
		reader,
		imageBase,
		functionEntry.unwindInfoAddress,
	);
	if (!info) {
		// Treat as leaf
		ctx.ip = await readQword(reader, ctx.sp);
		ctx.sp += 8n;
		return;
	}

	const funcOffset = Number(controlPc - imageBase) - functionEntry.beginAddress;
	const inProlog = funcOffset < info.sizeOfProlog;

	// Epilogue detection
	if (!inProlog) {
		if (info.version >= 2) {
			if (isInEpilogueV2(controlPc, imageBase, functionEntry, info)) {
				await emulateEpilogue(reader, controlPc, ctx);
				return;
			}
		} else {
			// Read instruction bytes once for both detection and emulation
			const instrBuf = await reader(controlPc, 32);
			const controlPcRva = Number(controlPc - imageBase);
			if (isInEpilogue(instrBuf, controlPcRva, functionEntry, info)) {
				await emulateEpilogueCore(instrBuf, ctx, reader);
				return;
			}
		}
	}

	// Not in epilogue — unwind through prolog
	await unwindPrologue(reader, imageBase, controlPc, functionEntry, ctx, info);
}

// --- Stack walking ---

export type StackFrame = {
	ip: bigint;
	sp: bigint;
	moduleName: string;
	moduleBase: bigint;
	offset: bigint;
};


export type WalkStackResult = {
	frames: StackFrame[];
	error?: string;
};

export async function walkStack(
	reader: MemoryReader,
	modules: DebugModule[],
	initialContext: Context,
	maxFrames = 64,
): Promise<WalkStackResult> {
	const frames: StackFrame[] = [];
	const ctx = initialContext.clone();
	const peCache = new Map<bigint, PeFile | null>();

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

		const prevRip = ctx.ip;

		try {
			if (mod) {
				const rva = Number(ctx.ip - mod.address);
				let pe = peCache.get(mod.address);
				if (pe === undefined) {
					pe = await getModulePeFile(mod);
					peCache.set(mod.address, pe);
				}
				const entry = pe
					? await pe.findRuntimeFunction(reader, mod.address, rva)
					: null;
				if (entry) {
					await virtualUnwind(reader, mod.address, ctx.ip, entry, ctx);
				} else {
					ctx.ip = await readQword(reader, ctx.sp);
					ctx.sp += 8n;
				}
			} else {
				ctx.ip = await readQword(reader, ctx.sp);
				ctx.sp += 8n;
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return { frames, error: msg };
		}

		if (ctx.ip === prevRip) break;
	}

	return { frames };
}
