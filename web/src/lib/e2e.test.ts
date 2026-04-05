import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
	decodeInstruction,
	decodeInstructionLength,
	joinSegmentText,
} from "./disassembly";
import {
	__setWasmExportsForTesting,
	ARCH_AMD64,
	ARCH_ARM64,
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

function decode(arch: number, bytes: number[], addr: bigint = 0x1000n) {
	const d = decodeInstruction(new Uint8Array(bytes), addr, arch);
	if (!d) throw new Error("decode failed");
	return d;
}

describe("AMD64 control flow", () => {
	it("ret", () => {
		const d = decode(ARCH_AMD64, [0xc3]);
		expect(d.controlFlow.kind).toBe("return");
	});

	it("call with direct target", () => {
		const d = decode(ARCH_AMD64, [0xe8, 0x10, 0x00, 0x00, 0x00], 0x1000n);
		expect(d.controlFlow.kind).toBe("call");
		expect(d.controlFlow.directTargetAddress).toBe(0x1015n);
	});

	it("jnz with direct target", () => {
		const d = decode(ARCH_AMD64, [0x75, 0x10], 0x1000n);
		expect(d.controlFlow.kind).toBe("conditional_branch");
		expect(d.controlFlow.directTargetAddress).toBe(0x1012n);
	});

	it("jmp", () => {
		const d = decode(ARCH_AMD64, [0xeb, 0x10], 0x1000n);
		expect(d.controlFlow.kind).toBe("unconditional_branch");
	});

	it("syscall", () => {
		const d = decode(ARCH_AMD64, [0x0f, 0x05]);
		expect(d.controlFlow.kind).toBe("syscall");
	});

	it("int3 has interrupt cf", () => {
		const d = decode(ARCH_AMD64, [0xcc]);
		expect(d.controlFlow.kind).toBe("interrupt");
	});

	it("ud2 has interrupt cf", () => {
		const d = decode(ARCH_AMD64, [0x0f, 0x0b]);
		expect(d.controlFlow.kind).toBe("interrupt");
	});
});

describe("AMD64 mnemonic strings", () => {
	const cases: [number[], string][] = [
		[[0xc3], "ret"],
		[[0x90], "nop"],
		[[0x48, 0x89, 0xd8], "mov"],
		[[0x55], "push"],
		[[0xe8, 0x10, 0x00, 0x00, 0x00], "call"],
		[[0x0f, 0x05], "syscall"],
		[[0x48, 0x01, 0xd8], "add"],
		[[0x48, 0x29, 0xd8], "sub"],
		[[0x48, 0x31, 0xc0], "xor"],
	];
	for (const [bytes, expected] of cases) {
		it(expected, () => {
			expect(decode(ARCH_AMD64, bytes).mnemonic).toBe(expected);
		});
	}
});

describe("AMD64 prefix in mnemonic", () => {
	it("lock prefix", () => {
		const d = decode(ARCH_AMD64, [0xf0, 0x0f, 0xb1, 0x11]);
		expect(d.mnemonic).toContain("lock");
	});

	it("rep prefix", () => {
		const d = decode(ARCH_AMD64, [0xf3, 0xa4]);
		expect(d.mnemonic).toContain("rep");
	});
});

describe("AMD64 formatted instruction text", () => {
	it("mov has register operands", () => {
		const d = decode(ARCH_AMD64, [0x48, 0x89, 0xd8]);
		const text = joinSegmentText(d.operandSegments);
		expect(text).toContain("rax");
		expect(text).toContain("rbx");
	});

	it("RIP-relative resolves to absolute address", () => {
		const d = decode(
			ARCH_AMD64,
			[0x48, 0x8d, 0x05, 0x34, 0x12, 0x00, 0x00],
			0x1000n,
		);
		expect(d.ripRelativeTargets.length).toBe(1);
		expect(d.ripRelativeTargets[0]).toBe(0x1000n + 7n + 0x1234n);
		const text = joinSegmentText(d.operandSegments);
		expect(text).toContain("0x");
	});

	it("branch target is absolute hex", () => {
		const d = decode(ARCH_AMD64, [0xe8, 0x10, 0x00, 0x00, 0x00], 0x1000n);
		const text = joinSegmentText(d.operandSegments);
		expect(text).toContain("0x1015");
	});

	it("branch target segment has targetAddress", () => {
		const d = decode(ARCH_AMD64, [0xe8, 0x10, 0x00, 0x00, 0x00], 0x1000n);
		const numSeg = d.operandSegments.find(
			(s) => s.syntaxKind === "number" && s.targetAddress !== undefined,
		);
		expect(numSeg).toBeDefined();
		expect(numSeg!.targetAddress).toBe(0x1015n);
	});
});

describe("ARM64 control flow", () => {
	it("ret", () => {
		const d = decode(ARCH_ARM64, [0xc0, 0x03, 0x5f, 0xd6]);
		expect(d.controlFlow.kind).toBe("return");
	});

	it("bl with direct target", () => {
		const d = decode(ARCH_ARM64, [0x05, 0x00, 0x00, 0x94], 0x1000n);
		expect(d.controlFlow.kind).toBe("call");
		expect(d.controlFlow.directTargetAddress).toBe(0x1014n);
	});

	it("b.eq → conditional branch", () => {
		const d = decode(ARCH_ARM64, [0x40, 0x00, 0x00, 0x54], 0x1000n);
		expect(d.controlFlow.kind).toBe("conditional_branch");
	});

	it("b → unconditional branch", () => {
		const d = decode(ARCH_ARM64, [0x03, 0x00, 0x00, 0x14], 0x1000n);
		expect(d.controlFlow.kind).toBe("unconditional_branch");
	});
});

describe("ARM64 mnemonic strings", () => {
	const cases: [number[], string][] = [
		[[0xc0, 0x03, 0x5f, 0xd6], "ret"],
		[[0x05, 0x00, 0x00, 0x94], "bl"],
		[[0x03, 0x00, 0x00, 0x14], "b"],
		[[0x00, 0x40, 0x00, 0x91], "add"],
		[[0xe0, 0x0b, 0x40, 0xf9], "ldr"],
		[[0xfd, 0x7b, 0xbf, 0xa9], "stp"],
	];
	for (const [bytes, expected] of cases) {
		it(expected, () => {
			expect(decode(ARCH_ARM64, bytes).mnemonic).toBe(expected);
		});
	}
});

describe("ARM64 formatted instruction text", () => {
	it("bl target is absolute hex", () => {
		const d = decode(ARCH_ARM64, [0x05, 0x00, 0x00, 0x94], 0x1000n);
		const text = joinSegmentText(d.operandSegments);
		expect(text).toContain("0x1014");
	});
});

describe("cross-arch decode_length", () => {
	it("AMD64 ret = 1", () => {
		expect(decodeInstructionLength(new Uint8Array([0xc3]), ARCH_AMD64)).toBe(1);
	});

	it("ARM64 = 4", () => {
		expect(
			decodeInstructionLength(
				new Uint8Array([0xc0, 0x03, 0x5f, 0xd6]),
				ARCH_ARM64,
			),
		).toBe(4);
	});
});
