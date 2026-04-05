import { describe, expect, it } from "bun:test";
import { computeScopeSize, expandCompactToFull } from "./arm64_unwinder";
import { Arm64Context, CONTEXT_ARM64 } from "./cpu_context";
import type { MemoryReader } from "./pe";

// --- Test helpers ---

function makeArm64Context(overrides?: {
	sp?: bigint;
	ip?: bigint;
	fp?: bigint;
	lr?: bigint;
	gprs?: Record<number, bigint>;
	simds?: Record<number, [bigint, bigint]>;
}): Arm64Context {
	const buf = new ArrayBuffer(0x310);
	const dv = new DataView(buf);
	dv.setUint32(0x0, CONTEXT_ARM64, true);
	// Set SP
	dv.setBigUint64(0x100, overrides?.sp ?? 0x10000n, true);
	// Set PC
	dv.setBigUint64(0x108, overrides?.ip ?? 0x70001000n, true);
	// Set FP (x29 at 0xF0)
	dv.setBigUint64(0xf0, overrides?.fp ?? 0n, true);
	// Set LR (x30 at 0xF8)
	dv.setBigUint64(0xf8, overrides?.lr ?? 0n, true);
	// Set GPRs
	if (overrides?.gprs) {
		for (const [idx, val] of Object.entries(overrides.gprs)) {
			const i = Number(idx);
			if (i <= 28) dv.setBigUint64(0x08 + i * 8, val, true);
			else if (i === 29) dv.setBigUint64(0xf0, val, true);
			else if (i === 30) dv.setBigUint64(0xf8, val, true);
		}
	}
	// Set SIMD registers
	if (overrides?.simds) {
		for (const [idx, [lo, hi]] of Object.entries(overrides.simds)) {
			const off = 0x110 + Number(idx) * 16;
			dv.setBigUint64(off, lo, true);
			dv.setBigUint64(off + 8, hi, true);
		}
	}
	return new Arm64Context(buf);
}

/** Build a mock memory reader from address->bytes map */
function mockReader(memory: Map<bigint, Uint8Array>): MemoryReader {
	return async (address: bigint, size: number) => {
		// Search for a region containing this address
		for (const [base, data] of memory) {
			if (
				address >= base &&
				address + BigInt(size) <= base + BigInt(data.length)
			) {
				const offset = Number(address - base);
				return data.subarray(offset, offset + size);
			}
		}
		// Return zeros for unmapped addresses
		return new Uint8Array(size);
	};
}

/** Build a Uint8Array from a list of byte values */
function bytes(...values: number[]): Uint8Array {
	return new Uint8Array(values);
}

/** Write a little-endian uint64 into a buffer */
function writeU64(buf: Uint8Array, offset: number, value: bigint): void {
	const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
	dv.setBigUint64(offset, value, true);
}

/** Write a little-endian uint32 into a buffer */
function writeU32(buf: Uint8Array, offset: number, value: number): void {
	const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
	dv.setUint32(offset, value, true);
}

// --- Tests ---

describe("ARM64 Unwinder", () => {
	describe("computeScopeSize", () => {
		it("should count single-byte opcodes", () => {
			// alloc_s (0x05) = 1 instruction, end (0xE4) terminates
			const codes = bytes(0x05, 0xe4);
			expect(computeScopeSize(codes, 0, codes.length, false)).toBe(1);
		});

		it("should count two-byte opcodes", () => {
			// save_regp (0xC8, 0x00) = 1 instruction, end (0xE4)
			const codes = bytes(0xc8, 0x00, 0xe4);
			expect(computeScopeSize(codes, 0, codes.length, false)).toBe(1);
		});

		it("should add 1 for epilog", () => {
			const codes = bytes(0x05, 0xe4);
			expect(computeScopeSize(codes, 0, codes.length, true)).toBe(2);
		});

		it("should count nop as 1 instruction", () => {
			const codes = bytes(0xe3, 0xe3, 0xe4);
			expect(computeScopeSize(codes, 0, codes.length, false)).toBe(2);
		});

		it("should handle alloc_l (4-byte opcode)", () => {
			// alloc_l: 0xE0 + 3 bytes = 1 instruction
			const codes = bytes(0xe0, 0x00, 0x00, 0x01, 0xe4);
			expect(computeScopeSize(codes, 0, codes.length, false)).toBe(1);
		});

		it("should handle e7 generic opcode (3 bytes)", () => {
			const codes = bytes(0xe7, 0x00, 0x00, 0xe4);
			expect(computeScopeSize(codes, 0, codes.length, false)).toBe(1);
		});

		it("should stop at end_c (0xE5)", () => {
			const codes = bytes(0x05, 0xe5, 0x03);
			expect(computeScopeSize(codes, 0, codes.length, false)).toBe(1);
		});

		it("should start at given offset", () => {
			const codes = bytes(0x05, 0x03, 0xe4);
			expect(computeScopeSize(codes, 1, codes.length, false)).toBe(1);
		});
	});

	describe("expandCompactToFull", () => {
		it("should produce end opcode for minimal function", () => {
			// Flag=1 (packed), FunctionLength=10, RegI=0, RegF=0, H=0, CR=0, FrameSize=0
			const unwindData =
				1 | // Flag
				(10 << 2) | // FunctionLength
				(0 << 13) | // RegF
				(0 << 16) | // RegI
				(0 << 20) | // H
				(0 << 21) | // CR
				(0 << 23); // FrameSize
			const { codes } = expandCompactToFull(unwindData);
			// Should contain at least the end opcode (0xE4)
			expect(codes.includes(0xe4)).toBe(true);
		});

		it("should save FP/LR for chained functions", () => {
			// CR=3 (chained), FrameSize=2 (2*2=4 8-byte units), no int/fp saves
			const unwindData =
				1 | // Flag
				(20 << 2) | // FunctionLength
				(0 << 13) | // RegF
				(0 << 16) | // RegI
				(0 << 20) | // H
				(3 << 21) | // CR = chained
				(2 << 23); // FrameSize = 2 -> famsz = 4
			const { codes } = expandCompactToFull(unwindData);
			// Should contain save_fplr_x (0x80-0xBF) and set_fp (0xE1)
			const hasSaveFplrX = codes.some((c) => c >= 0x80 && c <= 0xbf);
			const hasSetFp = codes.includes(0xe1);
			expect(hasSaveFplrX).toBe(true);
			expect(hasSetFp).toBe(true);
		});

		it("should save integer registers in pairs", () => {
			// RegI=4 (save x19-x22), FrameSize=3 -> famsz=6
			const unwindData =
				1 | // Flag
				(20 << 2) | // FunctionLength
				(0 << 13) | // RegF
				(4 << 16) | // RegI = 4
				(0 << 20) | // H
				(0 << 21) | // CR = unchained
				(3 << 23); // FrameSize = 3 -> famsz=6
			const { codes } = expandCompactToFull(unwindData);
			// Should contain save_regp_x (0xCC-0xCF) for first pair, then save_regp (0xC8-0xCB)
			const hasSaveRegpX = codes.some((c) => c >= 0xcc && c <= 0xcf);
			const hasSaveRegp = codes.some((c) => c >= 0xc8 && c <= 0xcb);
			expect(hasSaveRegpX).toBe(true);
			expect(hasSaveRegp).toBe(true);
		});

		it("should save FP registers", () => {
			// RegF=2 (save d8-d10, fpsz=3), RegI=0, FrameSize=2 -> famsz=4
			const unwindData =
				1 | // Flag
				(20 << 2) | // FunctionLength
				(2 << 13) | // RegF = 2 -> fpsz = 3
				(0 << 16) | // RegI = 0
				(0 << 20) | // H
				(0 << 21) | // CR = unchained
				(2 << 23); // FrameSize = 2 -> famsz = 4
			const { codes } = expandCompactToFull(unwindData);
			// Should contain save_fregp_x (0xDA-0xDB) and save_freg (0xDC-0xDD)
			const hasSaveFregpX = codes.some((c) => c >= 0xda && c <= 0xdb);
			expect(hasSaveFregpX).toBe(true);
		});

		it("should emit end_c for fragments", () => {
			// Flag=2 (fragment)
			const unwindData =
				2 | // Flag = fragment
				(10 << 2) | // FunctionLength
				(0 << 13) | // RegF
				(2 << 16) | // RegI = 2
				(0 << 20) | // H
				(0 << 21) | // CR
				(1 << 23); // FrameSize
			const { codes } = expandCompactToFull(unwindData);
			expect(codes.includes(0xe5)).toBe(true); // end_c
		});

		it("should emit pac for CR=2 (chained with PAC)", () => {
			const unwindData =
				1 | // Flag
				(20 << 2) | // FunctionLength
				(0 << 13) | // RegF
				(0 << 16) | // RegI
				(0 << 20) | // H
				(2 << 21) | // CR = chained with PAC
				(2 << 23); // FrameSize
			const { codes } = expandCompactToFull(unwindData);
			expect(codes.includes(0xfc)).toBe(true); // pac
		});

		it("should emit NOPs for home parameter area", () => {
			// H=1, RegI=2 (needs at least one save to trigger predec)
			const unwindData =
				1 | // Flag
				(20 << 2) | // FunctionLength
				(0 << 13) | // RegF
				(2 << 16) | // RegI = 2
				(1 << 20) | // H = 1
				(0 << 21) | // CR
				(6 << 23); // FrameSize = 6 -> famsz = 12
			const { codes } = expandCompactToFull(unwindData);
			// Count NOPs (0xE3) — should have at least 4
			const nopCount = codes.filter((c) => c === 0xe3).length;
			expect(nopCount).toBeGreaterThanOrEqual(4);
		});

		it("should handle save_lrpair for odd RegI with CR=1", () => {
			// RegI=3 (odd), CR=1 (unchained saved LR)
			const unwindData =
				1 | // Flag
				(20 << 2) | // FunctionLength
				(0 << 13) | // RegF
				(3 << 16) | // RegI = 3
				(0 << 20) | // H
				(1 << 21) | // CR = unchained saved LR
				(3 << 23); // FrameSize
			const { codes } = expandCompactToFull(unwindData);
			// Should contain save_lrpair (0xD6-0xD7)
			const hasSaveLrpair = codes.some((c) => c >= 0xd6 && c <= 0xd7);
			expect(hasSaveLrpair).toBe(true);
		});
	});

	describe("unwind opcode execution", () => {
		it("should handle alloc_s: adjust SP by 16*n", async () => {
			const { arm64VirtualUnwind } = await import("./arm64_unwinder");
			const ctx = makeArm64Context({
				sp: 0x10000n,
				ip: 0x70001008n, // past prolog
				lr: 0x70002000n,
			});

			// Build xdata: alloc_s(2) = 0x02, end = 0xE4, padded to 4 bytes
			// Header: FunctionLength=100, Version=0, ExceptionDataPresent=0,
			//         EpilogInHeader=0 (bit21=0), EpilogCount=0 (bits 26:22), CodeWords=1
			const functionLength = 100;
			const headerWord = functionLength | (1 << 27); // 1 CodeWord
			const xdata = new Uint8Array(8);
			writeU32(xdata, 0, headerWord);
			xdata[4] = 0x02; // alloc_s(2) -> SP += 32
			xdata[5] = 0xe4; // end
			xdata[6] = 0xe4;
			xdata[7] = 0xe4;

			const imageBase = 0x70000000n;
			const xdataRva = 0x3000;
			const funcBegin = 0x1000;

			const memory = new Map<bigint, Uint8Array>();
			memory.set(imageBase + BigInt(xdataRva), xdata);

			const entry = {
				beginAddress: funcBegin,
				unwindData: xdataRva, // Flag=0 -> full xdata
			};

			await arm64VirtualUnwind(
				mockReader(memory),
				imageBase,
				ctx.ip,
				entry,
				ctx,
			);

			// SP should have been adjusted by 32 (alloc_s(2) = 16*2)
			expect(ctx.sp).toBe(0x10000n + 32n);
			// PC should be set from LR
			expect(ctx.ip).toBe(0x70002000n);
		});

		it("should handle save_fplr: restore FP and LR from stack", async () => {
			const { arm64VirtualUnwind } = await import("./arm64_unwinder");

			// Stack at SP+0: saved FP, SP+8: saved LR
			const stackData = new Uint8Array(16);
			writeU64(stackData, 0, 0xdeadbeef00n); // saved FP
			writeU64(stackData, 8, 0x70003000n); // saved LR

			const ctx = makeArm64Context({
				sp: 0x10000n,
				ip: 0x70001008n,
				lr: 0x12345678n,
			});

			// xdata: save_fplr(0) = 0x40, end = 0xE4
			const functionLength = 100;
			const headerWord = functionLength | (1 << 27);
			const xdata = new Uint8Array(8);
			writeU32(xdata, 0, headerWord);
			xdata[4] = 0x40; // save_fplr offset=0
			xdata[5] = 0xe4; // end
			xdata[6] = 0xe4;
			xdata[7] = 0xe4;

			const imageBase = 0x70000000n;
			const memory = new Map<bigint, Uint8Array>();
			memory.set(imageBase + BigInt(0x3000), xdata);
			memory.set(0x10000n, stackData);

			const entry = {
				beginAddress: 0x1000,
				unwindData: 0x3000,
			};

			await arm64VirtualUnwind(
				mockReader(memory),
				imageBase,
				ctx.ip,
				entry,
				ctx,
			);

			expect(ctx.gpr(29)).toBe(0xdeadbeef00n); // FP restored
			expect(ctx.gpr(30)).toBe(0x70003000n); // LR restored
			expect(ctx.ip).toBe(0x70003000n); // PC = LR
		});

		it("should handle save_fplr_x: restore FP/LR with SP writeback", async () => {
			const { arm64VirtualUnwind } = await import("./arm64_unwinder");

			// save_fplr_x with offset = -8*((0x00 & 0x3f) + 1) = -8
			// SP writeback: SP += 8 (since offset is -8)
			// But first, registers are read from SP+0 (the read address for negative offset)
			const stackData = new Uint8Array(16);
			writeU64(stackData, 0, 0xaabb00n); // saved FP
			writeU64(stackData, 8, 0x70005000n); // saved LR

			const ctx = makeArm64Context({
				sp: 0x10000n,
				ip: 0x70001008n,
			});

			// save_fplr_x: 0x80 | (offset field), offset = -8*((field)+1)
			// For offset = -8: field = 0, so opcode = 0x80
			const functionLength = 100;
			const headerWord = functionLength | (1 << 27);
			const xdata = new Uint8Array(8);
			writeU32(xdata, 0, headerWord);
			xdata[4] = 0x80; // save_fplr_x with field=0 -> offset = -8*(0+1) = -8
			xdata[5] = 0xe4;
			xdata[6] = 0xe4;
			xdata[7] = 0xe4;

			const imageBase = 0x70000000n;
			const memory = new Map<bigint, Uint8Array>();
			memory.set(imageBase + BigInt(0x3000), xdata);
			memory.set(0x10000n, stackData);

			const entry = {
				beginAddress: 0x1000,
				unwindData: 0x3000,
			};

			await arm64VirtualUnwind(
				mockReader(memory),
				imageBase,
				ctx.ip,
				entry,
				ctx,
			);

			expect(ctx.gpr(29)).toBe(0xaabb00n); // FP restored
			expect(ctx.gpr(30)).toBe(0x70005000n); // LR restored
			expect(ctx.sp).toBe(0x10000n + 8n); // SP adjusted by abs(offset)
		});

		it("should handle save_regp: restore register pair from stack", async () => {
			const { arm64VirtualUnwind } = await import("./arm64_unwinder");

			// Set up stack with saved x19 and x20
			const stackData = new Uint8Array(16);
			writeU64(stackData, 0, 0x1919191919191919n); // saved x19
			writeU64(stackData, 8, 0x2020202020202020n); // saved x20

			const ctx = makeArm64Context({
				sp: 0x10000n,
				ip: 0x70001008n,
				lr: 0x70004000n,
			});

			// save_regp: 0xC8 | ((reg>>2)&3), next = ((reg&3)<<6) | (offset/8 & 0x3f)
			// reg = 0 (x19+0=x19), offset = 0
			const functionLength = 100;
			const headerWord = functionLength | (1 << 27);
			const xdata = new Uint8Array(8);
			writeU32(xdata, 0, headerWord);
			xdata[4] = 0xc8; // save_regp, reg high bits = 0
			xdata[5] = 0x00; // reg low bits = 0, offset = 0
			xdata[6] = 0xe4; // end
			xdata[7] = 0xe4;

			const imageBase = 0x70000000n;
			const memory = new Map<bigint, Uint8Array>();
			memory.set(imageBase + BigInt(0x3000), xdata);
			memory.set(0x10000n, stackData);

			const entry = {
				beginAddress: 0x1000,
				unwindData: 0x3000,
			};

			await arm64VirtualUnwind(
				mockReader(memory),
				imageBase,
				ctx.ip,
				entry,
				ctx,
			);

			expect(ctx.gpr(19)).toBe(0x1919191919191919n);
			expect(ctx.gpr(20)).toBe(0x2020202020202020n);
		});

		it("should handle save_fregp: restore FP register pair", async () => {
			const { arm64VirtualUnwind } = await import("./arm64_unwinder");

			// Stack with saved d8 and d9 (64-bit each)
			const stackData = new Uint8Array(16);
			writeU64(stackData, 0, 0x88n); // saved d8
			writeU64(stackData, 8, 0x99n); // saved d9

			const ctx = makeArm64Context({
				sp: 0x10000n,
				ip: 0x70001008n,
				lr: 0x70004000n,
			});

			// save_fregp: 0xD8 | ((reg>>2)&1), next = ((reg&3)<<6) | (offset/8 & 0x3f)
			// reg = 0 (d8+0=d8), offset = 0
			const functionLength = 100;
			const headerWord = functionLength | (1 << 27);
			const xdata = new Uint8Array(8);
			writeU32(xdata, 0, headerWord);
			xdata[4] = 0xd8; // save_fregp, reg bits = 0
			xdata[5] = 0x00; // reg low bits = 0, offset = 0
			xdata[6] = 0xe4; // end
			xdata[7] = 0xe4;

			const imageBase = 0x70000000n;
			const memory = new Map<bigint, Uint8Array>();
			memory.set(imageBase + BigInt(0x3000), xdata);
			memory.set(0x10000n, stackData);

			const entry = {
				beginAddress: 0x1000,
				unwindData: 0x3000,
			};

			await arm64VirtualUnwind(
				mockReader(memory),
				imageBase,
				ctx.ip,
				entry,
				ctx,
			);

			expect(ctx.simd(8)[0]).toBe(0x88n);
			expect(ctx.simd(9)[0]).toBe(0x99n);
		});

		it("should handle set_fp: restore SP from FP", async () => {
			const { arm64VirtualUnwind } = await import("./arm64_unwinder");

			const ctx = makeArm64Context({
				sp: 0x10000n,
				ip: 0x70001008n,
				lr: 0x70004000n,
				fp: 0x10100n, // FP points to a higher address
			});

			// set_fp (0xE1), end (0xE4)
			const functionLength = 100;
			const headerWord = functionLength | (1 << 27);
			const xdata = new Uint8Array(8);
			writeU32(xdata, 0, headerWord);
			xdata[4] = 0xe1; // set_fp
			xdata[5] = 0xe4; // end
			xdata[6] = 0xe4;
			xdata[7] = 0xe4;

			const imageBase = 0x70000000n;
			const memory = new Map<bigint, Uint8Array>();
			memory.set(imageBase + BigInt(0x3000), xdata);

			const entry = {
				beginAddress: 0x1000,
				unwindData: 0x3000,
			};

			await arm64VirtualUnwind(
				mockReader(memory),
				imageBase,
				ctx.ip,
				entry,
				ctx,
			);

			expect(ctx.sp).toBe(0x10100n); // SP = FP
		});

		it("should handle add_fp: SP = FP - 8*imm", async () => {
			const { arm64VirtualUnwind } = await import("./arm64_unwinder");

			const ctx = makeArm64Context({
				sp: 0x10000n,
				ip: 0x70001008n,
				lr: 0x70004000n,
				fp: 0x10100n,
			});

			// add_fp (0xE2, imm=4), end (0xE4)
			const functionLength = 100;
			const headerWord = functionLength | (1 << 27);
			const xdata = new Uint8Array(8);
			writeU32(xdata, 0, headerWord);
			xdata[4] = 0xe2; // add_fp
			xdata[5] = 0x04; // imm = 4, so SP = FP - 32
			xdata[6] = 0xe4; // end
			xdata[7] = 0xe4;

			const imageBase = 0x70000000n;
			const memory = new Map<bigint, Uint8Array>();
			memory.set(imageBase + BigInt(0x3000), xdata);

			const entry = {
				beginAddress: 0x1000,
				unwindData: 0x3000,
			};

			await arm64VirtualUnwind(
				mockReader(memory),
				imageBase,
				ctx.ip,
				entry,
				ctx,
			);

			expect(ctx.sp).toBe(0x10100n - 32n); // FP - 8*4
		});

		it("should handle alloc_m: medium stack allocation", async () => {
			const { arm64VirtualUnwind } = await import("./arm64_unwinder");

			const ctx = makeArm64Context({
				sp: 0x10000n,
				ip: 0x70001008n,
				lr: 0x70004000n,
			});

			// alloc_m: 0xC0 | high_bits, low_byte
			// Allocation = 16 * ((high<<8) + low) = 16 * 256 = 4096
			const functionLength = 100;
			const headerWord = functionLength | (1 << 27);
			const xdata = new Uint8Array(8);
			writeU32(xdata, 0, headerWord);
			xdata[4] = 0xc1; // alloc_m, high = 1
			xdata[5] = 0x00; // low = 0, total = 256 units * 16 = 4096
			xdata[6] = 0xe4; // end
			xdata[7] = 0xe4;

			const imageBase = 0x70000000n;
			const memory = new Map<bigint, Uint8Array>();
			memory.set(imageBase + BigInt(0x3000), xdata);

			const entry = {
				beginAddress: 0x1000,
				unwindData: 0x3000,
			};

			await arm64VirtualUnwind(
				mockReader(memory),
				imageBase,
				ctx.ip,
				entry,
				ctx,
			);

			expect(ctx.sp).toBe(0x10000n + 4096n);
		});

		it("should handle save_next_pair: accumulate register count", async () => {
			const { arm64VirtualUnwind } = await import("./arm64_unwinder");

			// Stack with x19, x20, x21, x22 saved
			const stackData = new Uint8Array(32);
			writeU64(stackData, 0, 0x19n);
			writeU64(stackData, 8, 0x20n);
			writeU64(stackData, 16, 0x21n);
			writeU64(stackData, 24, 0x22n);

			const ctx = makeArm64Context({
				sp: 0x10000n,
				ip: 0x70001008n,
				lr: 0x70004000n,
			});

			// save_next (0xE6), save_regp (0xC8, 0x00 -> x19-x20 at offset 0)
			// With 1 save_next, count = 2 + 2*1 = 4 registers
			const functionLength = 100;
			const headerWord = functionLength | (1 << 27);
			const xdata = new Uint8Array(8);
			writeU32(xdata, 0, headerWord);
			xdata[4] = 0xe6; // save_next_pair
			xdata[5] = 0xc8; // save_regp, reg=0
			xdata[6] = 0x00; // offset=0
			xdata[7] = 0xe4; // end

			const imageBase = 0x70000000n;
			const memory = new Map<bigint, Uint8Array>();
			memory.set(imageBase + BigInt(0x3000), xdata);
			memory.set(0x10000n, stackData);

			const entry = {
				beginAddress: 0x1000,
				unwindData: 0x3000,
			};

			await arm64VirtualUnwind(
				mockReader(memory),
				imageBase,
				ctx.ip,
				entry,
				ctx,
			);

			expect(ctx.gpr(19)).toBe(0x19n);
			expect(ctx.gpr(20)).toBe(0x20n);
			expect(ctx.gpr(21)).toBe(0x21n);
			expect(ctx.gpr(22)).toBe(0x22n);
		});

		it("should handle save_lrpair: restore register + LR", async () => {
			const { arm64VirtualUnwind } = await import("./arm64_unwinder");

			// Stack: x19 at offset 0, LR at offset 8
			const stackData = new Uint8Array(16);
			writeU64(stackData, 0, 0x1919n);
			writeU64(stackData, 8, 0x70006000n);

			const ctx = makeArm64Context({
				sp: 0x10000n,
				ip: 0x70001008n,
			});

			// save_lrpair: 0xD6 | ((pairIdx>>2)&1), ((pairIdx&3)<<6) | (offset/8 & 0x3f)
			// pairIdx = 0 (register = 19+2*0 = x19), offset = 0
			const functionLength = 100;
			const headerWord = functionLength | (1 << 27);
			const xdata = new Uint8Array(8);
			writeU32(xdata, 0, headerWord);
			xdata[4] = 0xd6; // save_lrpair
			xdata[5] = 0x00; // pairIdx=0, offset=0
			xdata[6] = 0xe4; // end
			xdata[7] = 0xe4;

			const imageBase = 0x70000000n;
			const memory = new Map<bigint, Uint8Array>();
			memory.set(imageBase + BigInt(0x3000), xdata);
			memory.set(0x10000n, stackData);

			const entry = {
				beginAddress: 0x1000,
				unwindData: 0x3000,
			};

			await arm64VirtualUnwind(
				mockReader(memory),
				imageBase,
				ctx.ip,
				entry,
				ctx,
			);

			expect(ctx.gpr(19)).toBe(0x1919n);
			expect(ctx.gpr(30)).toBe(0x70006000n); // LR restored
			expect(ctx.ip).toBe(0x70006000n); // PC = LR
		});

		it("should handle nop: no state change", async () => {
			const { arm64VirtualUnwind } = await import("./arm64_unwinder");

			const ctx = makeArm64Context({
				sp: 0x10000n,
				ip: 0x70001008n,
				lr: 0x70004000n,
			});

			const functionLength = 100;
			const headerWord = functionLength | (1 << 27);
			const xdata = new Uint8Array(8);
			writeU32(xdata, 0, headerWord);
			xdata[4] = 0xe3; // nop
			xdata[5] = 0xe4; // end
			xdata[6] = 0xe4;
			xdata[7] = 0xe4;

			const imageBase = 0x70000000n;
			const memory = new Map<bigint, Uint8Array>();
			memory.set(imageBase + BigInt(0x3000), xdata);

			const entry = {
				beginAddress: 0x1000,
				unwindData: 0x3000,
			};

			await arm64VirtualUnwind(
				mockReader(memory),
				imageBase,
				ctx.ip,
				entry,
				ctx,
			);

			expect(ctx.sp).toBe(0x10000n); // unchanged
			expect(ctx.ip).toBe(0x70004000n); // PC = LR
		});
	});

	describe("leaf function handling", () => {
		it("should copy LR to PC when no pdata entry is found", async () => {
			const { arm64WalkStack } = await import("./arm64_unwinder");

			const ctx = makeArm64Context({
				sp: 0x10000n,
				ip: 0x70001000n,
				lr: 0x70002000n,
			});

			// Walk with no modules — every frame is a leaf
			const result = await arm64WalkStack(mockReader(new Map()), [], ctx, 2);

			expect(result.frames.length).toBe(2);
			expect(result.frames[0].ip).toBe(0x70001000n);
			expect(result.frames[1].ip).toBe(0x70002000n);
		});
	});

	describe("prolog detection", () => {
		it("should skip unexecuted codes when in prolog", async () => {
			const { arm64VirtualUnwind } = await import("./arm64_unwinder");

			// Prolog: alloc_s(4) then save_fplr(0) — 2 instructions
			// If we're at instruction 1 (only alloc_s executed), skip save_fplr
			const stackData = new Uint8Array(64);
			// At SP+0: saved FP/LR (should NOT be restored since save_fplr hasn't executed)
			writeU64(stackData, 0, 0xbadn);
			writeU64(stackData, 8, 0xbadn);

			const ctx = makeArm64Context({
				sp: 0x10000n,
				// Function begins at RVA 0x1000, PC is 1 instruction in (4 bytes)
				ip: 0x70001004n,
				lr: 0x70009000n,
			});

			// xdata: save_fplr(0) = 0x40, alloc_s(4) = 0x04, end = 0xE4
			// Scope size = 2 instructions. OffsetInFunction = 1 instruction.
			// skipWords = 2 - 1 = 1, so save_fplr is skipped, only alloc_s is processed
			const functionLength = 100;
			const headerWord = functionLength | (1 << 27);
			const xdata = new Uint8Array(8);
			writeU32(xdata, 0, headerWord);
			xdata[4] = 0x40; // save_fplr offset=0 (this will be skipped)
			xdata[5] = 0x04; // alloc_s(4) -> SP += 64
			xdata[6] = 0xe4; // end
			xdata[7] = 0xe4;

			const imageBase = 0x70000000n;
			const memory = new Map<bigint, Uint8Array>();
			memory.set(imageBase + BigInt(0x3000), xdata);
			memory.set(0x10000n, stackData);

			const entry = {
				beginAddress: 0x1000,
				unwindData: 0x3000,
			};

			await arm64VirtualUnwind(
				mockReader(memory),
				imageBase,
				ctx.ip,
				entry,
				ctx,
			);

			// Only alloc_s(4) should have executed: SP += 64
			expect(ctx.sp).toBe(0x10000n + 64n);
			// PC should come from LR
			expect(ctx.ip).toBe(0x70009000n);
		});
	});

	describe("full xdata parsing", () => {
		it("should parse xdata header and execute codes in function body", async () => {
			const { arm64VirtualUnwind } = await import("./arm64_unwinder");

			// Set up a function with: alloc_s(2) + save_fplr(0)
			// Prolog is 2 instructions, function length = 50 instructions
			// PC is well past prolog (instruction 10)

			const stackData = new Uint8Array(48);
			writeU64(stackData, 0, 0xfeedn); // saved FP at offset 0
			writeU64(stackData, 8, 0x70007000n); // saved LR at offset 8

			const ctx = makeArm64Context({
				sp: 0x10000n,
				ip: 0x70001028n, // instruction 10 = 0x1000 + 40
				lr: 0x11111111n, // this should be overwritten
			});

			const functionLength = 50;
			const headerWord = functionLength | (1 << 27); // 1 CodeWord
			const xdata = new Uint8Array(8);
			writeU32(xdata, 0, headerWord);
			xdata[4] = 0x40; // save_fplr offset=0
			xdata[5] = 0x02; // alloc_s(2) -> SP += 32
			xdata[6] = 0xe4; // end
			xdata[7] = 0xe4;

			const imageBase = 0x70000000n;
			const memory = new Map<bigint, Uint8Array>();
			memory.set(imageBase + BigInt(0x3000), xdata);
			memory.set(0x10000n, stackData);

			const entry = {
				beginAddress: 0x1000,
				unwindData: 0x3000,
			};

			await arm64VirtualUnwind(
				mockReader(memory),
				imageBase,
				ctx.ip,
				entry,
				ctx,
			);

			// Both codes executed: save_fplr restores FP/LR, alloc_s adjusts SP
			expect(ctx.gpr(29)).toBe(0xfeedn); // FP restored
			// SP = 0x10000 + 32 (from alloc_s)
			expect(ctx.sp).toBe(0x10000n + 32n);
			// PC = restored LR
			expect(ctx.ip).toBe(0x70007000n);
		});
	});

	describe("machine frame and custom opcodes", () => {
		it("should handle machine frame (0xE9): restore SP and PC", async () => {
			const { arm64VirtualUnwind } = await import("./arm64_unwinder");

			// Machine frame at SP: SP_value, PC_value
			const stackData = new Uint8Array(16);
			writeU64(stackData, 0, 0x20000n); // new SP
			writeU64(stackData, 8, 0x70008000n); // new PC

			const ctx = makeArm64Context({
				sp: 0x10000n,
				ip: 0x70001008n,
				lr: 0x70004000n,
			});

			const functionLength = 100;
			const headerWord = functionLength | (1 << 27);
			const xdata = new Uint8Array(8);
			writeU32(xdata, 0, headerWord);
			xdata[4] = 0xe9; // machine_frame
			xdata[5] = 0xe4; // end
			xdata[6] = 0xe4;
			xdata[7] = 0xe4;

			const imageBase = 0x70000000n;
			const memory = new Map<bigint, Uint8Array>();
			memory.set(imageBase + BigInt(0x3000), xdata);
			memory.set(0x10000n, stackData);

			const entry = {
				beginAddress: 0x1000,
				unwindData: 0x3000,
			};

			await arm64VirtualUnwind(
				mockReader(memory),
				imageBase,
				ctx.ip,
				entry,
				ctx,
			);

			expect(ctx.sp).toBe(0x20000n);
			expect(ctx.ip).toBe(0x70008000n);
		});

		it("should handle clear_unwound_to_call (0xEC): PC = LR", async () => {
			const { arm64VirtualUnwind } = await import("./arm64_unwinder");

			const ctx = makeArm64Context({
				sp: 0x10000n,
				ip: 0x70001008n,
				lr: 0x70009000n,
			});

			const functionLength = 100;
			const headerWord = functionLength | (1 << 27);
			const xdata = new Uint8Array(8);
			writeU32(xdata, 0, headerWord);
			xdata[4] = 0xec; // clear_unwound_to_call
			xdata[5] = 0xe4; // end
			xdata[6] = 0xe4;
			xdata[7] = 0xe4;

			const imageBase = 0x70000000n;
			const memory = new Map<bigint, Uint8Array>();
			memory.set(imageBase + BigInt(0x3000), xdata);

			const entry = {
				beginAddress: 0x1000,
				unwindData: 0x3000,
			};

			await arm64VirtualUnwind(
				mockReader(memory),
				imageBase,
				ctx.ip,
				entry,
				ctx,
			);

			// clear_unwound_to_call sets PC = LR directly via unwindCustom
			// then finalPcFromLr is false, so no double-set
			expect(ctx.ip).toBe(0x70009000n);
		});
	});

	describe("compact format unwinding", () => {
		it("should unwind a simple compact function with integer saves", async () => {
			const { arm64VirtualUnwind } = await import("./arm64_unwinder");

			// Compact pdata: Flag=1, FunctionLength=20, RegI=2, RegF=0, H=0, CR=0, FrameSize=1
			// famsz=2, intsz=2, savsz=2, locsz=0
			const unwindData =
				1 | // Flag = packed
				(20 << 2) | // FunctionLength
				(0 << 13) | // RegF
				(2 << 16) | // RegI = 2 (x19, x20)
				(0 << 20) | // H
				(0 << 21) | // CR = unchained
				(1 << 23); // FrameSize = 1 -> famsz=2

			// Stack: x19, x20 saved by save_regp_x
			const stackData = new Uint8Array(16);
			writeU64(stackData, 0, 0x1919n);
			writeU64(stackData, 8, 0x2020n);

			const ctx = makeArm64Context({
				sp: 0x10000n,
				ip: 0x70001028n, // well into function body (instruction 10)
				lr: 0x70005000n,
			});

			const imageBase = 0x70000000n;
			const memory = new Map<bigint, Uint8Array>();
			memory.set(0x10000n, stackData);

			const entry = {
				beginAddress: 0x1000,
				unwindData,
			};

			await arm64VirtualUnwind(
				mockReader(memory),
				imageBase,
				ctx.ip,
				entry,
				ctx,
			);

			expect(ctx.gpr(19)).toBe(0x1919n);
			expect(ctx.gpr(20)).toBe(0x2020n);
			// SP should be adjusted by save area (2 * 8 = 16 bytes)
			expect(ctx.sp).toBe(0x10000n + 16n);
		});
	});
});
