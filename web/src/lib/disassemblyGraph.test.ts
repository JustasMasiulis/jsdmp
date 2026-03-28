import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { DisassemblyMemorySource } from "./debugDisassembly";
import {
	buildCfgInstructionLine,
	buildCfgInstructionLines,
	buildCfgTextLinesFromLabel,
	buildControlFlowGraph,
	tokenizeCfgTextSegments,
} from "./disassemblyGraph";
import {
	type WasmExports,
	WASM_MEMORY,
	__setWasmExportsForTesting,
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
		currentContext: 0n,
	},
	read: async (address, size) => {
		const segment = segments.find((candidate) => {
			const endExclusive = candidate.start + BigInt(candidate.bytes.byteLength);
			return (
				address >= candidate.start &&
				address + BigInt(size) <= endExclusive
			);
		});
		if (!segment) {
			throw new Error("missing memory");
		}

		const offset = Number(address - segment.start);
		return segment.bytes.slice(offset, offset + size);
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

describe("buildControlFlowGraph", () => {
	it("does not expose an anchor-specific node id on successful builds", async () => {
		const anchorAddress = 0x1000n;
		const source = makeSource([
			{ start: anchorAddress, bytes: new Uint8Array([0xc3]) },
		]);
		const result = await buildControlFlowGraph(source, anchorAddress);

		expect(result.status).toBe("ok");
		expect("anchorNodeId" in result).toBe(false);
		expect(result.blocks).toHaveLength(1);
		expect(result.blocks[0]?.id).toBe("block:1000");
	});

	it("still reports decode_error when the anchor address cannot be decoded", async () => {
		const anchorAddress = 0x2000n;
		const source = makeSource([
			{ start: anchorAddress, bytes: new Uint8Array([0x0f]) },
		]);
		const result = await buildControlFlowGraph(source, anchorAddress);

		expect(result.status).toBe("decode_error");
		expect(result.blocks).toHaveLength(1);
		expect(result.blocks[0]?.kind).toBe("decode_error");
		expect(result.message).toContain("Failed to decode an instruction");
	});

	it("returns missing_memory when the anchor address is outside dump memory", async () => {
		const result = await buildControlFlowGraph(makeSource([]), 0x3000n);

		expect(result.status).toBe("missing_memory");
		expect(result.blocks).toHaveLength(0);
		expect(result.edges).toHaveLength(0);
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

		expect(line.text).toBe(
			"0000000000401000  mov qword ptr [rax+0x20], rbx",
		);
		expect(
			line.segments
				.filter((segment) => segment.clickable)
				.map((segment) => segment.term),
		).toEqual(["0000000000401000", "mov", "qword", "ptr", "rax", "0x20", "rbx"]);
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
		const lines = buildCfgTextLinesFromLabel("missing memory\n0000000000001000");

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
