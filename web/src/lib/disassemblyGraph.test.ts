import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { DisassemblyMemorySource } from "./debugDisassembly";
import {
	buildCfg2,
	buildCfgInstructionLine,
	buildCfgInstructionLines,
	buildCfgTextLinesFromLabel,
	tokenizeCfgTextSegments,
} from "./disassemblyGraph";
import {
	__setWasmExportsForTesting,
	WASM_MEMORY,
	type WasmExports,
} from "./wasm";

type MemorySegment = {
	start: bigint;
	bytes: Uint8Array;
};

const makeSource = (segments: MemorySegment[]): DisassemblyMemorySource => ({
	dm: {
		threads: [],
		modules: [],
		unloadedModules: [],
		memoryRanges: segments.map((segment) => ({
			address: segment.start,
			size: BigInt(segment.bytes.byteLength),
		})),
		currentThreadId: 0,
		currentContext: null,
	},
	read: async (address, size, minSize) => {
		const segment = segments.find((candidate) => {
			const endExclusive = candidate.start + BigInt(candidate.bytes.byteLength);
			return address >= candidate.start && address < endExclusive;
		});
		if (!segment) {
			throw new Error("missing memory");
		}

		const offset = Number(address - segment.start);
		const available = segment.bytes.byteLength - offset;
		const requiredSize = minSize ?? size;
		if (available < requiredSize) {
			throw new Error("missing memory");
		}

		const byteCount = Math.min(size, available);
		return segment.bytes.slice(offset, offset + byteCount);
	},
});

beforeAll(async () => {
	const wasmFile = Bun.file(
		new URL("../../public/web_dmp.wasm", import.meta.url),
	);
	const { instance } = await WebAssembly.instantiate(
		await wasmFile.arrayBuffer(),
		{ env: { memory: WASM_MEMORY } },
	);
	__setWasmExportsForTesting(instance.exports as unknown as WasmExports);
});

afterAll(() => {
	__setWasmExportsForTesting(null);
});

describe("buildCfg2", () => {
	it("single ret: produces one block with no edges", async () => {
		const anchorAddress = 0x1000n;
		// c3  ret
		const result = await buildCfg2(
			makeSource([{ start: anchorAddress, bytes: new Uint8Array([0xc3]) }]),
			anchorAddress,
		);

		expect(result.blocks).toHaveLength(1);
		expect(result.blocks[0]?.id).toBe("block:1000");
		expect(result.edges).toHaveLength(0);
	});

	it("conditional branch: splits into two successor blocks with correct edge kinds", async () => {
		const anchorAddress = 0x1000n;
		// 1000: 74 03  je +3 → 0x1005
		// 1002: 90 90 c3  false path
		// 1005: 90 c3     true path
		const bytes = new Uint8Array([0x74, 0x03, 0x90, 0x90, 0xc3, 0x90, 0xc3]);
		const result = await buildCfg2(
			makeSource([{ start: anchorAddress, bytes }]),
			anchorAddress,
		);

		expect(result.blocks.map((b) => b.id).sort()).toEqual([
			"block:1000",
			"block:1002",
			"block:1005",
		]);
		expect(
			result.edges.find((e) => e.from === "block:1000" && e.kind === "true")
				?.to,
		).toBe("block:1005");
		expect(
			result.edges.find((e) => e.from === "block:1000" && e.kind === "false")
				?.to,
		).toBe("block:1002");
	});

	it("direct unconditional jump: creates target block", async () => {
		const anchorAddress = 0x1000n;
		// 1000: eb 01  jmp short +1 → 0x1003
		// 1002: 90     nop (unreachable)
		// 1003: c3     ret
		const bytes = new Uint8Array([0xeb, 0x01, 0x90, 0xc3]);
		const result = await buildCfg2(
			makeSource([{ start: anchorAddress, bytes }]),
			anchorAddress,
		);

		expect(result.blocks.map((b) => b.id).sort()).toEqual([
			"block:1000",
			"block:1003",
		]);
		expect(result.edges).toHaveLength(1);
		expect(result.edges[0]?.from).toBe("block:1000");
		expect(result.edges[0]?.to).toBe("block:1003");
		expect(result.edges[0]?.kind).toBe("unconditional");
	});

	it("self-loop: terminates and produces a self-referencing edge", async () => {
		const anchorAddress = 0x1000n;
		// 1000: eb fe  jmp short -2 → 0x1000
		const bytes = new Uint8Array([0xeb, 0xfe]);
		const result = await buildCfg2(
			makeSource([{ start: anchorAddress, bytes }]),
			anchorAddress,
		);

		expect(result.blocks).toHaveLength(1);
		expect(result.edges).toHaveLength(1);
		expect(result.edges[0]?.from).toBe("block:1000");
		expect(result.edges[0]?.to).toBe("block:1000");
		expect(result.edges[0]?.kind).toBe("unconditional");
	});

	it("diamond: two paths converging at a shared join block", async () => {
		const anchorAddress = 0x1000n;
		// 1000: 74 02  je +2 → 0x1004
		// 1002: eb 00  jmp +0 → 0x1004
		// 1004: c3     ret
		const bytes = new Uint8Array([0x74, 0x02, 0xeb, 0x00, 0xc3]);
		const result = await buildCfg2(
			makeSource([{ start: anchorAddress, bytes }]),
			anchorAddress,
		);

		expect(result.blocks.map((b) => b.id).sort()).toEqual([
			"block:1000",
			"block:1002",
			"block:1004",
		]);
		expect(result.edges).toHaveLength(3);
		expect(
			result.edges.find((e) => e.from === "block:1000" && e.kind === "true")
				?.to,
		).toBe("block:1004");
		expect(
			result.edges.find((e) => e.from === "block:1000" && e.kind === "false")
				?.to,
		).toBe("block:1002");
		expect(result.edges.find((e) => e.from === "block:1002")?.to).toBe(
			"block:1004",
		);
	});

	it("indirect unconditional jump (jmp rax): produces no successors — no edge, no new block", async () => {
		const anchorAddress = 0x1000n;
		// 1000: ff e0  jmp rax  (indirect — directTargetAddress is null)
		// 1002: c3     ret (unreachable)
		const bytes = new Uint8Array([0xff, 0xe0, 0xc3]);
		const result = await buildCfg2(
			makeSource([{ start: anchorAddress, bytes }]),
			anchorAddress,
		);

		expect(result.blocks).toHaveLength(1);
		expect(result.blocks[0]?.id).toBe("block:1000");
		expect(result.edges).toHaveLength(0);
		expect(result.blocks.find((b) => b.id === "block:1002")).toBeUndefined();
	});

	it("splits a fallthrough block before a previously discovered target", async () => {
		const entryAddress = 0x1000n;
		const result = await buildCfg2(
			makeSource([
				{
					start: entryAddress,
					bytes: new Uint8Array([0x75, 0x02, 0x90, 0x90, 0xc3]),
				},
			]),
			entryAddress,
		);

		expect(result.blocks.map((block) => block.id).sort()).toEqual([
			"block:1000",
			"block:1002",
			"block:1004",
		]);

		const fallthroughBlock = result.blocks.find(
			(block) => block.id === "block:1002",
		);
		expect(fallthroughBlock?.instructionCount).toBe(2);
		expect(fallthroughBlock?.lines.map((line) => line.text)).toEqual([
			"0000000000001002  nop",
			"0000000000001003  nop",
		]);
		expect(
			result.edges.some(
				(edge) =>
					edge.from === "block:1002" &&
					edge.to === "block:1004" &&
					edge.kind === "unconditional",
			),
		).toBe(true);
	});
});

describe("tokenizeCfgTextSegments", () => {
	it("splits operands into literal tokens and separator text", () => {
		const text = "qword ptr [rax+0x20], rbx";
		const segments = tokenizeCfgTextSegments(text);

		expect(segments.map((segment) => segment.text).join("")).toBe(text);
		expect(
			segments
				.filter((segment) => segment.clickable)
				.map((segment) => segment.term),
		).toEqual(["qword", "ptr", "rax", "0x20", "rbx"]);
		expect(
			segments
				.filter((segment) => segment.clickable)
				.map((segment) => segment.syntaxKind),
		).toEqual(["plain", "plain", "plain", "number", "plain"]);
		expect(
			segments
				.filter((segment) => !segment.clickable)
				.map((segment) => segment.text),
		).toEqual([" ", " [", "+", "], "]);
	});
});

describe("buildCfgInstructionLine", () => {
	it("preserves the rendered graph line while exposing clickable tokens", () => {
		const line = buildCfgInstructionLine({
			address: 0x401000n,
			mnemonic: "mov",
			operands: "qword ptr [rax+0x20], rbx",
		});

		expect(line.text).toBe("0000000000401000  mov qword ptr [rax+0x20], rbx");
		expect(
			line.segments
				.filter((segment) => segment.clickable)
				.map((segment) => segment.term),
		).toEqual([
			"0000000000401000",
			"mov",
			"qword",
			"ptr",
			"rax",
			"0x20",
			"rbx",
		]);
		expect(
			line.segments
				.filter((segment) => segment.clickable)
				.map((segment) => segment.syntaxKind),
		).toEqual([
			"plain",
			"mnemonic",
			"plain",
			"plain",
			"plain",
			"number",
			"plain",
		]);
	});
});

describe("buildCfgInstructionLines", () => {
	it("pads mnemonics so operand columns align within a block", () => {
		const lines = buildCfgInstructionLines([
			{
				address: 0x401000n,
				mnemonic: "mov",
				operands: "rax, rbx",
			},
			{
				address: 0x401002n,
				mnemonic: "cmovne",
				operands: "rcx, rdx",
			},
			{
				address: 0x401004n,
				mnemonic: "ret",
				operands: "",
			},
		]);

		expect(lines.map((line) => line.text)).toEqual([
			"0000000000401000  mov    rax, rbx",
			"0000000000401002  cmovne rcx, rdx",
			"0000000000401004  ret",
		]);
	});
});

describe("buildCfgTextLinesFromLabel", () => {
	it("tokenizes synthetic labels without changing the visible text", () => {
		const lines = buildCfgTextLinesFromLabel(
			"missing memory\n0000000000001000",
		);

		expect(lines).toHaveLength(2);
		expect(lines.map((line) => line.text).join("\n")).toBe(
			"missing memory\n0000000000001000",
		);
		expect(
			lines[0]?.segments
				.filter((segment) => segment.clickable)
				.map((segment) => segment.term),
		).toEqual(["missing", "memory"]);
		expect(
			lines[1]?.segments
				.filter((segment) => segment.clickable)
				.map((segment) => segment.term),
		).toEqual(["0000000000001000"]);
		expect(
			lines[1]?.segments
				.filter((segment) => segment.clickable)
				.map((segment) => segment.syntaxKind),
		).toEqual(["number"]);
	});
});
