import type { Context } from "./cpu_context";
import type { DebugModule } from "./debug_interface";
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

// --- Mutable context ---

export type UnwindContext = {
	rip: bigint;
	rsp: bigint;
	rax: bigint;
	rcx: bigint;
	rdx: bigint;
	rbx: bigint;
	rbp: bigint;
	rsi: bigint;
	rdi: bigint;
	r8: bigint;
	r9: bigint;
	r10: bigint;
	r11: bigint;
	r12: bigint;
	r13: bigint;
	r14: bigint;
	r15: bigint;
};

const GPR_KEYS = [
	"rax",
	"rcx",
	"rdx",
	"rbx",
	"rsp",
	"rbp",
	"rsi",
	"rdi",
	"r8",
	"r9",
	"r10",
	"r11",
	"r12",
	"r13",
	"r14",
	"r15",
] as const;

function getGpr(ctx: UnwindContext, idx: number): bigint {
	return ctx[GPR_KEYS[idx]];
}

function setGpr(ctx: UnwindContext, idx: number, val: bigint) {
	(ctx as Record<string, bigint>)[GPR_KEYS[idx]] = val;
}

export function contextFromCpuContext(ctx: Context): UnwindContext {
	return {
		rip: ctx.ip,
		rsp: ctx.sp,
		rax: ctx.gpr(0),
		rcx: ctx.gpr(1),
		rdx: ctx.gpr(2),
		rbx: ctx.gpr(3),
		rbp: ctx.gpr(5),
		rsi: ctx.gpr(6),
		rdi: ctx.gpr(7),
		r8: ctx.gpr(8),
		r9: ctx.gpr(9),
		r10: ctx.gpr(10),
		r11: ctx.gpr(11),
		r12: ctx.gpr(12),
		r13: ctx.gpr(13),
		r14: ctx.gpr(14),
		r15: ctx.gpr(15),
	};
}

// --- Helpers ---

async function readQword(reader: MemoryReader, addr: bigint): Promise<bigint> {
	const buf = await reader(addr, 8);
	const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
	return view.getBigUint64(0, true);
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
	return (codes[idx + 1].frameOffset << 16) | codes[idx].frameOffset;
}

// --- Prologue unwinding ---

async function unwindPrologue(
	reader: MemoryReader,
	imageBase: bigint,
	controlPc: bigint,
	functionEntry: RuntimeFunction,
	ctx: UnwindContext,
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

		// Determine frame base
		let frameBase: bigint;
		if (info.frameRegister !== 0) {
			frameBase =
				getGpr(ctx, info.frameRegister) - BigInt(info.frameOffset * 16);
		} else {
			frameBase = ctx.rsp;
		}

		let i = 0;
		while (i < info.countOfUnwindCodes) {
			const code = info.unwindCodes[i];
			const slots = unwindOpSlots(code);

			// In the prolog: only process codes we've already executed
			if (prologOffset >= code.codeOffset) {
				switch (code.unwindOp) {
					case UWOP_PUSH_NONVOL:
						setGpr(ctx, code.opInfo, await readQword(reader, ctx.rsp));
						ctx.rsp += 8n;
						break;

					case UWOP_ALLOC_LARGE:
						if (code.opInfo === 0) {
							ctx.rsp += BigInt(slotU16(info.unwindCodes, i + 1) * 8);
						} else {
							ctx.rsp += BigInt(slotU32(info.unwindCodes, i + 1));
						}
						break;

					case UWOP_ALLOC_SMALL:
						ctx.rsp += BigInt(code.opInfo * 8 + 8);
						break;

					case UWOP_SET_FPREG:
						ctx.rsp =
							getGpr(ctx, info.frameRegister) - BigInt(info.frameOffset * 16);
						break;

					case UWOP_SAVE_NONVOL: {
						const offset = BigInt(slotU16(info.unwindCodes, i + 1) * 8);
						setGpr(
							ctx,
							code.opInfo,
							await readQword(reader, frameBase + offset),
						);
						break;
					}

					case UWOP_SAVE_NONVOL_FAR: {
						const offset = BigInt(slotU32(info.unwindCodes, i + 1));
						setGpr(
							ctx,
							code.opInfo,
							await readQword(reader, frameBase + offset),
						);
						break;
					}

					case UWOP_EPILOG:
						// Version 2 epilog marker — skip
						break;

					case UWOP_SAVE_XMM128:
					case UWOP_SAVE_XMM128_FAR:
						// We don't track XMM registers
						break;

					case UWOP_PUSH_MACHFRAME: {
						const hasPushError = code.opInfo !== 0;
						const base = ctx.rsp + (hasPushError ? 8n : 0n);
						ctx.rip = await readQword(reader, base);
						ctx.rsp = await readQword(reader, base + 24n);
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
	ctx.rip = await readQword(reader, ctx.rsp);
	ctx.rsp += 8n;
}

// --- Epilogue detection and unwinding ---

function isInEpilogue(buf: Uint8Array): boolean {
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
	// Check for lea rsp, [reg+disp8] or [reg+disp32]
	else if (buf[i] === SIZE64_PREFIX && buf[i + 1] === LEA_OP) {
		const modrm = buf[i + 2];
		const reg = (modrm >> 3) & 0x07;
		if (reg !== 4) return false; // must target RSP
		const mod = (modrm >> 6) & 0x03;
		if (mod === 1) {
			i += 4; // disp8
		} else if (mod === 2) {
			i += 7; // disp32
		} else {
			return false;
		}
	}

	// Pop sequence: 0x58-0x5F or REX.B pop (41 58-5F)
	while (i < buf.length) {
		if (buf[i] >= POP_OP && buf[i] <= POP_OP + 7) {
			i += 1;
		} else if (
			buf[i] === 0x41 &&
			buf[i + 1] >= POP_OP &&
			buf[i + 1] <= POP_OP + 7
		) {
			i += 2;
		} else {
			break;
		}
	}

	if (i >= buf.length) return false;

	// Must end with ret, ret imm16, jmp rel8, jmp rel32, or rex jmp [reg]
	if (buf[i] === RET_OP || buf[i] === RET_OP_2) return true;
	if (buf[i] === JMP_IMM8_OP || buf[i] === JMP_IMM32_OP) return true;
	if (buf[i] === REPNE_PREFIX || buf[i] === REP_PREFIX) {
		// rep ret
		i += 1;
		if (buf[i] === RET_OP) return true;
	}
	// jmp [reg] (ff /4)
	if (buf[i] === JMP_IND_OP) {
		const modrm = buf[i + 1];
		const reg = (modrm >> 3) & 0x07;
		if (reg === 4) return true; // /4 = jmp
	}
	// rex.w jmp [reg]
	if (buf[i] === SIZE64_PREFIX && buf[i + 1] === JMP_IND_OP) {
		const modrm = buf[i + 2];
		const reg = (modrm >> 3) & 0x07;
		if (reg === 4) return true;
	}

	return false;
}

function emulateEpilogueFromBuffer(
	buf: Uint8Array,
	ctx: UnwindContext,
	reader: MemoryReader,
): Promise<void> {
	return emulateEpilogueCore(buf, ctx, reader);
}

async function emulateEpilogue(
	reader: MemoryReader,
	controlPc: bigint,
	ctx: UnwindContext,
): Promise<void> {
	const buf = await reader(controlPc, 32);
	return emulateEpilogueCore(buf, ctx, reader);
}

async function emulateEpilogueCore(
	buf: Uint8Array,
	ctx: UnwindContext,
	reader: MemoryReader,
): Promise<void> {
	const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
	let i = 0;

	// add rsp, imm8
	if (
		buf[i] === SIZE64_PREFIX &&
		buf[i + 1] === ADD_IMM8_OP &&
		buf[i + 2] === 0xc4
	) {
		ctx.rsp += BigInt(buf[i + 3]);
		i += 4;
	}
	// add rsp, imm32
	else if (
		buf[i] === SIZE64_PREFIX &&
		buf[i + 1] === ADD_IMM32_OP &&
		buf[i + 2] === 0xc4
	) {
		ctx.rsp += BigInt(view.getUint32(i + 3, true));
		i += 7;
	}
	// lea rsp, [reg+disp]
	else if (buf[i] === SIZE64_PREFIX && buf[i + 1] === LEA_OP) {
		const modrm = buf[i + 2];
		const rm = modrm & 0x07;
		const mod = (modrm >> 6) & 0x03;
		// rm is the source register (with REX.B=0, this maps to GPR index directly)
		const srcReg = rm; // no REX.B in the patterns we check
		if (mod === 1) {
			const disp = buf[i + 3];
			const signedDisp = disp > 127 ? disp - 256 : disp;
			ctx.rsp = getGpr(ctx, srcReg) + BigInt(signedDisp);
			i += 4;
		} else if (mod === 2) {
			const disp = view.getInt32(i + 3, true);
			ctx.rsp = getGpr(ctx, srcReg) + BigInt(disp);
			i += 7;
		}
	}

	// Pop sequence
	while (i < buf.length) {
		if (buf[i] >= POP_OP && buf[i] <= POP_OP + 7) {
			const reg = buf[i] - POP_OP;
			setGpr(ctx, reg, await readQword(reader, ctx.rsp));
			ctx.rsp += 8n;
			i += 1;
		} else if (
			buf[i] === 0x41 &&
			buf[i + 1] >= POP_OP &&
			buf[i + 1] <= POP_OP + 7
		) {
			const reg = buf[i + 1] - POP_OP + 8; // REX.B = +8
			setGpr(ctx, reg, await readQword(reader, ctx.rsp));
			ctx.rsp += 8n;
			i += 2;
		} else {
			break;
		}
	}

	// Return: read RIP from [RSP], advance RSP
	if (buf[i] === RET_OP || buf[i] === RET_OP_2) {
		ctx.rip = await readQword(reader, ctx.rsp);
		ctx.rsp += 8n;
		if (buf[i] === RET_OP_2) {
			ctx.rsp += BigInt(view.getUint16(i + 1, true));
		}
	} else if (buf[i] === REP_PREFIX || buf[i] === REPNE_PREFIX) {
		// rep ret
		ctx.rip = await readQword(reader, ctx.rsp);
		ctx.rsp += 8n;
	} else {
		// jmp variants — treat as tail call, read return address from stack
		ctx.rip = await readQword(reader, ctx.rsp);
		ctx.rsp += 8n;
	}
}

function isInEpilogueV2(
	controlPc: bigint,
	imageBase: bigint,
	functionEntry: RuntimeFunction,
	info: UnwindInfo,
): boolean {
	const funcOffset = Number(controlPc - imageBase) - functionEntry.beginAddress;

	// Scan for UWOP_EPILOG codes
	let i = 0;
	let firstEpilogOffset = -1;
	while (i < info.countOfUnwindCodes) {
		const code = info.unwindCodes[i];
		if (code.unwindOp === UWOP_EPILOG) {
			if (firstEpilogOffset < 0) {
				// First UWOP_EPILOG: opInfo has flags, offset is in the code's data
				const epilogSize = code.codeOffset;
				if (code.opInfo & 0x01) {
					// Epilog at end of function
					const endOffset =
						functionEntry.endAddress - functionEntry.beginAddress;
					firstEpilogOffset = endOffset - epilogSize;
					if (funcOffset >= firstEpilogOffset && funcOffset < endOffset) {
						return true;
					}
				}
			} else {
				// Subsequent UWOP_EPILOG: offset from function start
				const offset = (code.opInfo << 8) | code.codeOffset;
				if (offset === 0) {
					i += 1;
					continue;
				}
				const epilogSize = info.unwindCodes[0].codeOffset;
				if (funcOffset >= offset && funcOffset < offset + epilogSize) {
					return true;
				}
			}
		}
		i += 1;
	}

	return false;
}

// --- Main virtual unwind ---

export async function virtualUnwind(
	reader: MemoryReader,
	imageBase: bigint,
	controlPc: bigint,
	functionEntry: RuntimeFunction,
	ctx: UnwindContext,
): Promise<void> {
	const info = await readUnwindInfo(
		reader,
		imageBase,
		functionEntry.unwindInfoAddress,
	);
	if (!info) {
		// Treat as leaf
		ctx.rip = await readQword(reader, ctx.rsp);
		ctx.rsp += 8n;
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
			if (isInEpilogue(instrBuf)) {
				emulateEpilogueFromBuffer(instrBuf, ctx, reader);
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

function findModule(ip: bigint, modules: DebugModule[]): DebugModule | null {
	for (const m of modules) {
		if (ip >= m.address && ip < m.address + BigInt(m.size)) {
			return m;
		}
	}
	return null;
}

export type WalkStackResult = {
	frames: StackFrame[];
	error?: string;
};

export async function walkStack(
	reader: MemoryReader,
	modules: DebugModule[],
	initialContext: UnwindContext,
	maxFrames = 64,
): Promise<WalkStackResult> {
	const frames: StackFrame[] = [];
	const ctx: UnwindContext = { ...initialContext };
	const peCache = new Map<bigint, PeFile | null>();

	for (let i = 0; i < maxFrames; i++) {
		if (ctx.rip === 0n) break;

		const mod = findModule(ctx.rip, modules);
		frames.push({
			ip: ctx.rip,
			sp: ctx.rsp,
			moduleName: mod ? basename(mod.path) : "<unknown>",
			moduleBase: mod?.address ?? 0n,
			offset: mod ? ctx.rip - mod.address : ctx.rip,
		});

		const prevRip = ctx.rip;

		try {
			if (mod) {
				const rva = Number(ctx.rip - mod.address);
				let pe = peCache.get(mod.address);
				if (pe === undefined) {
					pe = await getModulePeFile(mod);
					peCache.set(mod.address, pe);
				}
				const entry = pe
					? await pe.findRuntimeFunction(reader, mod.address, rva)
					: null;
				if (entry) {
					await virtualUnwind(reader, mod.address, ctx.rip, entry, ctx);
				} else {
					ctx.rip = await readQword(reader, ctx.rsp);
					ctx.rsp += 8n;
				}
			} else {
				ctx.rip = await readQword(reader, ctx.rsp);
				ctx.rsp += 8n;
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return { frames, error: msg };
		}

		if (ctx.rip === prevRip) break;
	}

	return { frames };
}
