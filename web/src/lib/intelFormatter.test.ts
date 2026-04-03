import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { decodeInstruction, joinSegmentText } from "./disassembly";
import {
	type DecodedInstructionHeader,
	type DecodedOperandImm,
	type DecodedOperandMem,
	type DecodedOperandReg,
	formatInstruction,
} from "./intelFormatter";
import { registerName, ZydisRegister } from "./register";
import {
	__setWasmExportsForTesting,
	WASM_MEMORY,
	type WasmExports,
} from "./wasm";

beforeAll(async () => {
	const wasmFile = Bun.file(
		new URL("../../public/web_dmp.wasm", import.meta.url),
	);
	const { instance } = await WebAssembly.instantiate(
		await wasmFile.arrayBuffer(),
		{ env: { memory: WASM_MEMORY } },
	);
	const raw = instance.exports as Record<string, unknown>;
	__setWasmExportsForTesting({
		...raw,
		decoded_buffer: (raw.wasm_get_decoded_buffer as () => number)(),
		disassembly_buffer: (raw.wasm_get_disassembly_buffer as () => number)(),
	} as unknown as WasmExports);
});

afterAll(() => {
	__setWasmExportsForTesting(null);
});

function header(
	overrides: Partial<DecodedInstructionHeader> & { mnemonic: number },
): DecodedInstructionHeader {
	return {
		length: 1,
		operandCount: 0,
		controlFlowKind: 0,
		hasDirectTarget: false,
		encoding: 0,
		addressWidth: 64,
		operandWidth: 64,
		stackWidth: 64,
		attributes: 0n,
		directTarget: 0n,
		avxVectorLength: 0,
		avxMaskReg: 0,
		avxBroadcast: 0,
		avxRounding: 0,
		avxHasSae: false,
		avxMaskMode: 0,
		...overrides,
	};
}

function mnemonicIdFromBytes(bytes: Uint8Array, address: bigint): number {
	const decoded = decodeInstruction(bytes, address);
	return decoded?.mnemonicId ?? 0;
}

describe("registerName", () => {
	it("returns empty string for NONE", () => {
		expect(registerName(ZydisRegister.NONE)).toBe("");
	});

	it("returns correct names for GPR 8-bit", () => {
		expect(registerName(ZydisRegister.AL)).toBe("al");
		expect(registerName(ZydisRegister.BH)).toBe("bh");
		expect(registerName(ZydisRegister.R15B)).toBe("r15b");
	});

	it("returns correct names for GPR 64-bit", () => {
		expect(registerName(ZydisRegister.RAX)).toBe("rax");
		expect(registerName(ZydisRegister.RSP)).toBe("rsp");
		expect(registerName(ZydisRegister.R15)).toBe("r15");
	});

	it("returns correct names for segment registers", () => {
		expect(registerName(ZydisRegister.FS)).toBe("fs");
		expect(registerName(ZydisRegister.GS)).toBe("gs");
	});

	it("returns correct names for vector registers", () => {
		expect(registerName(ZydisRegister.XMM0)).toBe("xmm0");
		expect(registerName(ZydisRegister.YMM31)).toBe("ymm31");
		expect(registerName(ZydisRegister.ZMM15)).toBe("zmm15");
	});

	it("returns correct names for mask registers", () => {
		expect(registerName(ZydisRegister.K0)).toBe("k0");
		expect(registerName(ZydisRegister.K7)).toBe("k7");
	});

	it("returns correct names for special registers", () => {
		expect(registerName(ZydisRegister.RIP)).toBe("rip");
		expect(registerName(ZydisRegister.RFLAGS)).toBe("rflags");
		expect(registerName(ZydisRegister.MXCSR)).toBe("mxcsr");
	});
});

describe("formatInstruction", () => {
	it("mov rax, rbx", () => {
		const bytes = new Uint8Array([0x48, 0x89, 0xd8]);
		const mid = mnemonicIdFromBytes(bytes, 0x1000n);
		const reg1: DecodedOperandReg = {
			type: 1,
			size: 64,
			reg: ZydisRegister.RAX,
		};
		const reg2: DecodedOperandReg = {
			type: 1,
			size: 64,
			reg: ZydisRegister.RBX,
		};
		const result = formatInstruction(
			header({ mnemonic: mid, length: 3, operandCount: 2 }),
			[reg1, reg2],
			0x1000n,
		);
		expect(result).toBe("mov rax, rbx");
	});

	it("mov rax, qword ptr [rbp-0x8]", () => {
		const bytes = new Uint8Array([0x48, 0x8b, 0x45, 0xf8]);
		const mid = mnemonicIdFromBytes(bytes, 0x1000n);
		const reg: DecodedOperandReg = {
			type: 1,
			size: 64,
			reg: ZydisRegister.RAX,
		};
		const mem: DecodedOperandMem = {
			type: 2,
			size: 64,
			base: ZydisRegister.RBP,
			index: ZydisRegister.NONE,
			scale: 1,
			hasDisplacement: true,
			displacement: -8n,
			segment: 2,
			memType: 0,
		};
		const result = formatInstruction(
			header({ mnemonic: mid, length: 4, operandCount: 2 }),
			[reg, mem],
			0x1000n,
		);
		expect(result).toBe("mov rax, qword ptr [rbp-0x8]");
	});

	it("mov eax, 0x42", () => {
		const bytes = new Uint8Array([0xb8, 0x42, 0x00, 0x00, 0x00]);
		const mid = mnemonicIdFromBytes(bytes, 0x1000n);
		const reg: DecodedOperandReg = {
			type: 1,
			size: 32,
			reg: ZydisRegister.EAX,
		};
		const imm: DecodedOperandImm = {
			type: 4,
			size: 32,
			isSigned: false,
			isRelative: false,
			value: 0x42n,
		};
		const result = formatInstruction(
			header({ mnemonic: mid, length: 5, operandCount: 2, operandWidth: 32 }),
			[reg, imm],
			0x1000n,
		);
		expect(result).toBe("mov eax, 0x00000042");
	});

	it("mov rax, qword ptr [rcx+rdx*8+0x10]", () => {
		const bytes = new Uint8Array([0x48, 0x8b, 0x44, 0xd1, 0x10]);
		const mid = mnemonicIdFromBytes(bytes, 0x1000n);
		const reg: DecodedOperandReg = {
			type: 1,
			size: 64,
			reg: ZydisRegister.RAX,
		};
		const mem: DecodedOperandMem = {
			type: 2,
			size: 64,
			base: ZydisRegister.RCX,
			index: ZydisRegister.RDX,
			scale: 8,
			hasDisplacement: true,
			displacement: 0x10n,
			segment: 3,
			memType: 0,
		};
		const result = formatInstruction(
			header({ mnemonic: mid, length: 5, operandCount: 2 }),
			[reg, mem],
			0x1000n,
		);
		expect(result).toBe("mov rax, qword ptr [rcx+rdx*8+0x10]");
	});

	it("jne 0x401020 (relative branch)", () => {
		const bytes = new Uint8Array([0x75, 0x1e]);
		const mid = mnemonicIdFromBytes(bytes, 0x401000n);
		const imm: DecodedOperandImm = {
			type: 4,
			size: 8,
			isSigned: true,
			isRelative: true,
			value: 0x1en,
		};
		const result = formatInstruction(
			header({
				mnemonic: mid,
				length: 2,
				operandCount: 1,
				controlFlowKind: 2,
				hasDirectTarget: true,
				directTarget: 0x401020n,
			}),
			[imm],
			0x401000n,
		);
		expect(result).toBe("jnz 0x401020");
	});

	it("lea rax, [rip+0x1234] (no size qualifier for AGEN)", () => {
		const bytes = new Uint8Array([0x48, 0x8d, 0x05, 0x34, 0x12, 0x00, 0x00]);
		const mid = mnemonicIdFromBytes(bytes, 0x1000n);
		const reg: DecodedOperandReg = {
			type: 1,
			size: 64,
			reg: ZydisRegister.RAX,
		};
		const mem: DecodedOperandMem = {
			type: 2,
			size: 64,
			base: ZydisRegister.RIP,
			index: ZydisRegister.NONE,
			scale: 1,
			hasDisplacement: true,
			displacement: 0x1234n,
			segment: 3,
			memType: 1,
		};
		const result = formatInstruction(
			header({ mnemonic: mid, length: 7, operandCount: 2 }),
			[reg, mem],
			0x1000n,
		);
		expect(result).toBe("lea rax, [0x223B]");
	});

	it("lock cmpxchg [rcx], edx", () => {
		const bytes = new Uint8Array([0xf0, 0x0f, 0xb1, 0x11]);
		const mid = mnemonicIdFromBytes(bytes, 0x1000n);
		const mem: DecodedOperandMem = {
			type: 2,
			size: 32,
			base: ZydisRegister.RCX,
			index: ZydisRegister.NONE,
			scale: 1,
			hasDisplacement: false,
			displacement: 0n,
			segment: 3,
			memType: 0,
		};
		const reg: DecodedOperandReg = {
			type: 1,
			size: 32,
			reg: ZydisRegister.EDX,
		};
		const result = formatInstruction(
			header({
				mnemonic: mid,
				length: 4,
				operandCount: 2,
				attributes: 1n << 27n,
			}),
			[mem, reg],
			0x1000n,
		);
		expect(result).toBe("lock cmpxchg dword ptr [rcx], edx");
	});

	it("rep movsb", () => {
		const bytes = new Uint8Array([0xf3, 0xa4]);
		const mid = mnemonicIdFromBytes(bytes, 0x1000n);
		const result = formatInstruction(
			header({
				mnemonic: mid,
				length: 2,
				operandCount: 0,
				attributes: 1n << 28n,
			}),
			[],
			0x1000n,
		);
		expect(result).toBe("rep movsb");
	});

	it("mov rax, qword ptr fs:[0x28] (segment override)", () => {
		const bytes = new Uint8Array([
			0x64, 0x48, 0x8b, 0x04, 0x25, 0x28, 0x00, 0x00, 0x00,
		]);
		const mid = mnemonicIdFromBytes(bytes, 0x1000n);
		const reg: DecodedOperandReg = {
			type: 1,
			size: 64,
			reg: ZydisRegister.RAX,
		};
		const mem: DecodedOperandMem = {
			type: 2,
			size: 64,
			base: ZydisRegister.NONE,
			index: ZydisRegister.NONE,
			scale: 1,
			hasDisplacement: true,
			displacement: 0x28n,
			segment: 5,
			memType: 0,
		};
		const result = formatInstruction(
			header({
				mnemonic: mid,
				length: 9,
				operandCount: 2,
				attributes: 1n << 41n,
			}),
			[reg, mem],
			0x1000n,
		);
		expect(result).toBe("mov rax, qword ptr fs:[0x28]");
	});

	it("ret", () => {
		const bytes = new Uint8Array([0xc3]);
		const mid = mnemonicIdFromBytes(bytes, 0x1000n);
		const result = formatInstruction(
			header({ mnemonic: mid, length: 1, operandCount: 0, controlFlowKind: 4 }),
			[],
			0x1000n,
		);
		expect(result).toBe("ret");
	});

	it("nop", () => {
		const bytes = new Uint8Array([0x90]);
		const mid = mnemonicIdFromBytes(bytes, 0x1000n);
		const result = formatInstruction(
			header({ mnemonic: mid, length: 1, operandCount: 0 }),
			[],
			0x1000n,
		);
		expect(result).toBe("nop");
	});

	it("push rbx", () => {
		const bytes = new Uint8Array([0x53]);
		const mid = mnemonicIdFromBytes(bytes, 0x1000n);
		const reg: DecodedOperandReg = {
			type: 1,
			size: 64,
			reg: ZydisRegister.RBX,
		};
		const result = formatInstruction(
			header({ mnemonic: mid, length: 1, operandCount: 1 }),
			[reg],
			0x1000n,
		);
		expect(result).toBe("push rbx");
	});

	it("pop rbx", () => {
		const bytes = new Uint8Array([0x5b]);
		const mid = mnemonicIdFromBytes(bytes, 0x1000n);
		const reg: DecodedOperandReg = {
			type: 1,
			size: 64,
			reg: ZydisRegister.RBX,
		};
		const result = formatInstruction(
			header({ mnemonic: mid, length: 1, operandCount: 1 }),
			[reg],
			0x1000n,
		);
		expect(result).toBe("pop rbx");
	});

	it("call with relative immediate", () => {
		const bytes = new Uint8Array([0xe8, 0xfb, 0x0f, 0x00, 0x00]);
		const mid = mnemonicIdFromBytes(bytes, 0x401000n);
		const imm: DecodedOperandImm = {
			type: 4,
			size: 32,
			isSigned: true,
			isRelative: true,
			value: 0xffbn,
		};
		const result = formatInstruction(
			header({
				mnemonic: mid,
				length: 5,
				operandCount: 1,
				controlFlowKind: 1,
				hasDirectTarget: true,
				directTarget: 0x402000n,
			}),
			[imm],
			0x401000n,
		);
		expect(result).toBe("call 0x402000");
	});

	it("mov eax, dword ptr [0x601000] (displacement only)", () => {
		const bytes = new Uint8Array([0x8b, 0x04, 0x25, 0x00, 0x10, 0x60, 0x00]);
		const mid = mnemonicIdFromBytes(bytes, 0x1000n);
		const reg: DecodedOperandReg = {
			type: 1,
			size: 32,
			reg: ZydisRegister.EAX,
		};
		const mem: DecodedOperandMem = {
			type: 2,
			size: 32,
			base: ZydisRegister.NONE,
			index: ZydisRegister.NONE,
			scale: 1,
			hasDisplacement: true,
			displacement: 0x601000n,
			segment: 3,
			memType: 0,
		};
		const result = formatInstruction(
			header({ mnemonic: mid, length: 7, operandCount: 2, operandWidth: 32 }),
			[reg, mem],
			0x1000n,
		);
		expect(result).toBe("mov eax, dword ptr [0x601000]");
	});

	it("AVX mask decorator", () => {
		const bytes = new Uint8Array([0x62, 0xf1, 0xfd, 0x49, 0x6f, 0xc1]);
		const mid = mnemonicIdFromBytes(bytes, 0x1000n);
		const dst: DecodedOperandReg = {
			type: 1,
			size: 512,
			reg: ZydisRegister.ZMM0,
		};
		const src: DecodedOperandReg = {
			type: 1,
			size: 512,
			reg: ZydisRegister.ZMM1,
		};
		const result = formatInstruction(
			header({
				mnemonic: mid,
				length: 6,
				operandCount: 2,
				avxMaskReg: 1,
				avxMaskMode: 0,
				encoding: 4,
			}),
			[dst, src],
			0x1000n,
		);
		expect(result).toContain("{k1}");
	});

	it("AVX mask with zeroing", () => {
		const bytes = new Uint8Array([0x62, 0xf1, 0xfd, 0xc9, 0x6f, 0xc1]);
		const mid = mnemonicIdFromBytes(bytes, 0x1000n);
		const dst: DecodedOperandReg = {
			type: 1,
			size: 512,
			reg: ZydisRegister.ZMM0,
		};
		const src: DecodedOperandReg = {
			type: 1,
			size: 512,
			reg: ZydisRegister.ZMM1,
		};
		const result = formatInstruction(
			header({
				mnemonic: mid,
				length: 6,
				operandCount: 2,
				avxMaskReg: 1,
				avxMaskMode: 2,
				encoding: 4,
			}),
			[dst, src],
			0x1000n,
		);
		expect(result).toContain("{k1}");
		expect(result).toContain("{z}");
	});
});

describe("decodeInstruction parity", () => {
	it("ret: full pipeline decode", () => {
		const decoded = decodeInstruction(new Uint8Array([0xc3]), 0x1000n);
		expect(decoded).not.toBeNull();
		expect(decoded?.mnemonic).toBe("ret");
		expect(decoded?.length).toBe(1);
		expect(decoded?.operandSegments).toEqual([]);
	});

	it("nop: full pipeline decode", () => {
		const decoded = decodeInstruction(new Uint8Array([0x90]), 0x1000n);
		expect(decoded).not.toBeNull();
		expect(decoded?.mnemonic).toBe("nop");
	});

	it("push rbx: full pipeline decode", () => {
		const decoded = decodeInstruction(new Uint8Array([0x53]), 0x1000n);
		expect(decoded).not.toBeNull();
		expect(decoded.mnemonic).toBe("push");
		expect(joinSegmentText(decoded.operandSegments)).toBe("rbx");
	});

	it("pop rbx: full pipeline decode", () => {
		const decoded = decodeInstruction(new Uint8Array([0x5b]), 0x1000n);
		expect(decoded).not.toBeNull();
		expect(decoded.mnemonic).toBe("pop");
		expect(joinSegmentText(decoded.operandSegments)).toBe("rbx");
	});
});
