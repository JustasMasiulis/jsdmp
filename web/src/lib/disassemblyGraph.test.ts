import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { ProcessorArch } from "./debug_interface";
import type { DisassemblyMemorySource } from "./debugDisassembly";
import {
	buildCfg2,
	buildCfgInstructionLine,
	buildCfgInstructionLines,
	buildCfgTextLinesFromLabel,
} from "./disassemblyGraph";
import type { InstrTextSegment } from "./instructionParser";
import { Signal } from "./reactive";
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
	threads: new Signal([]),
	modules: new Signal([]),
	unloadedModules: new Signal([]),
	memoryRanges: new Signal(
		segments.map((s) => ({
			address: s.start,
			size: BigInt(s.bytes.byteLength),
		})),
	),
	currentThread: new Signal(null),
	currentContext: new Signal(null),
	arch: ProcessorArch.ARCH_AMD64,
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
	selectThread() {},
});

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

	it("retroactively splits an already-committed block when a later branch targets its middle", async () => {
		// Need a block fully committed before a mid-block target is discovered.
		// Key insight: with LIFO, the LAST pushed address is popped FIRST.
		// For conditional je: true target pushed first, fallthrough pushed second,
		// so fallthrough is popped first.
		//
		// Layout:
		// 0x1000: je 0x1010       (true → 0x1010, false/fallthrough → 0x1002)
		// 0x1002: nop nop nop c3  (the block that must be split at 0x1004)
		// ...padding...
		// 0x1010: jmp 0x1004      (targets middle of 0x1002 block)
		//
		// LIFO trace:
		//   pending: [0x1000]
		//   pop 0x1000 → je 0x1010: push 0x1010 (true), push 0x1002 (false)
		//   pending: [0x1010, 0x1002]
		//   pop 0x1002 → nop, nop, nop, ret → committed with 4 instructions
		//   instrToBlock: {0x1002→0x1002, 0x1003→0x1002, 0x1004→0x1002, 0x1005→0x1002}
		//   pending: [0x1010]
		//   pop 0x1010 → jmp 0x1004 → addPendingBlock(0x1004)
		//     0x1004 NOT in blocks, but instrToBlock has 0x1004→0x1002
		//     → must retroactively split block 0x1002 at 0x1004!

		const entryAddress = 0x1000n;
		// Build a byte buffer with padding between 0x1006 and 0x1010
		const buf = new Uint8Array(0x12);
		buf.set([0x74, 0x0e], 0x00); // 1000: je +0x0e → 0x1010
		buf.set([0x90, 0x90, 0x90, 0xc3], 0x02); // 1002: nop nop nop ret
		buf.set([0xcc, 0xcc, 0xcc, 0xcc, 0xcc, 0xcc, 0xcc, 0xcc, 0xcc, 0xcc], 0x06); // padding
		buf.set([0xeb, 0xf2], 0x10); // 1010: jmp -0x0e → 0x1004

		const result = await buildCfg2(
			makeSource([{ start: entryAddress, bytes: buf }]),
			entryAddress,
		);

		expect(result.blocks.map((b) => b.id).sort()).toEqual([
			"block:1000",
			"block:1002",
			"block:1004",
			"block:1010",
		]);

		const block1002 = result.blocks.find((b) => b.id === "block:1002");
		expect(block1002?.instructionCount).toBe(2);
		expect(block1002?.lines.map((l) => l.text)).toEqual([
			"0000000000001002  nop",
			"0000000000001003  nop",
		]);

		const block1004 = result.blocks.find((b) => b.id === "block:1004");
		expect(block1004?.instructionCount).toBe(2);
		expect(block1004?.lines.map((l) => l.text)).toEqual([
			"0000000000001004  nop",
			"0000000000001005  ret",
		]);

		// Head→tail fallthrough
		expect(
			result.edges.some(
				(e) =>
					e.from === "block:1002" &&
					e.to === "block:1004" &&
					e.kind === "unconditional",
			),
		).toBe(true);
		// Jump into mid-block
		expect(
			result.edges.some(
				(e) =>
					e.from === "block:1010" &&
					e.to === "block:1004" &&
					e.kind === "unconditional",
			),
		).toBe(true);
	});

	it("splits when a backward branch targets the middle of its own block", async () => {
		// Block branches backward into its own instruction range.
		// The target is queued before the block is committed, so the split
		// must happen at pop time.
		//
		// 0x1000: nop             (1 byte)
		// 0x1001: nop             (1 byte)
		// 0x1002: 75 fd  jne -3 → 0x1001  (backward conditional into own middle)
		//
		// Without pop-time split: block 0x1000 is committed as [nop,nop,jne],
		// then 0x1001 is popped and re-decoded, creating overlap.
		// With pop-time split: popping 0x1001 splits block 0x1000 into
		// head [0x1000:nop] and tail [0x1001:nop, 0x1002:jne].

		const entryAddress = 0x1000n;
		const bytes = new Uint8Array([0x90, 0x90, 0x75, 0xfd]);
		const result = await buildCfg2(
			makeSource([{ start: entryAddress, bytes }]),
			entryAddress,
		);

		expect(result.blocks.map((b) => b.id).sort()).toEqual([
			"block:1000",
			"block:1001",
			"block:1004",
		]);

		const block1000 = result.blocks.find((b) => b.id === "block:1000");
		expect(block1000?.instructionCount).toBe(1);

		const block1001 = result.blocks.find((b) => b.id === "block:1001");
		expect(block1001?.instructionCount).toBe(2);

		expect(
			result.edges.some(
				(e) =>
					e.from === "block:1000" &&
					e.to === "block:1001" &&
					e.kind === "unconditional",
			),
		).toBe(true);
		expect(
			result.edges.some(
				(e) =>
					e.from === "block:1001" && e.to === "block:1001" && e.kind === "true",
			),
		).toBe(true);
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

	it("no block has overlapping instructions with another block", async () => {
		// Long straight-line block with multiple backward branches into
		// different points in its middle. Entry falls through the whole
		// thing; a later block sends branches back into it at two offsets.
		//
		// 0x1000: eb 10  jmp +16 → 0x1012
		// 0x1002: 90     nop  \
		// 0x1003: 90     nop   |
		// 0x1004: 90     nop   | long block decoded as one unit
		// 0x1005: 90     nop   | before any mid-targets are discovered
		// 0x1006: 90     nop   |
		// 0x1007: 90     nop   |
		// 0x1008: 90     nop   |
		// 0x1009: 90     nop   |
		// 0x100a: 90     nop   |
		// 0x100b: 90     nop   |
		// 0x100c: 90     nop   |
		// 0x100d: 90     nop   |
		// 0x100e: 90     nop   |
		// 0x100f: c3     ret  /
		// 0x1010: cc     int3 (padding)
		// 0x1011: cc     int3 (padding)
		// 0x1012: 74 ee  je -18 → 0x1002 (true → start of long block)
		// 0x1014: 74 f0  je -16 → 0x1006 (true → mid-block #1)
		// 0x1016: eb ee  jmp -18 → 0x1006 (should dedup, not double-edge)
		// Unreachable after jmp, but 0x100a is targeted below:
		// 0x1018: eb f0  jmp -16 → 0x100a (mid-block #2, from different block)
		//
		// Because 0x1012 is a je, fallthrough is 0x1014. 0x1014 is also je,
		// fallthrough is 0x1016. 0x1016 is jmp (no fallthrough).
		// LIFO processing ensures long block at 0x1002 is built before
		// the mid-block targets 0x1006 and 0x100a are discovered.
		const entryAddress = 0x1000n;
		const buf = new Uint8Array(0x1a);
		buf.set([0xeb, 0x10], 0x00); // 1000: jmp → 0x1012
		// 1002..100e: nops
		for (let i = 0x02; i <= 0x0e; i++) buf[i] = 0x90;
		buf[0x0f] = 0xc3; // 100f: ret
		buf[0x10] = 0xcc; // 1010: int3
		buf[0x11] = 0xcc; // 1011: int3
		buf.set([0x74, 0xee], 0x12); // 1012: je → 0x1002
		buf.set([0x74, 0xf0], 0x14); // 1014: je → 0x1006
		buf.set([0xeb, 0xee], 0x16); // 1016: jmp → 0x1006
		buf.set([0xeb, 0xf0], 0x18); // 1018: jmp → 0x100a
		const bytes = buf;
		const result = await buildCfg2(
			makeSource([{ start: entryAddress, bytes }]),
			entryAddress,
		);

		const blockAddresses = result.blocks.map((b) => ({
			id: b.id,
			addresses: b.lines
				.filter((l) => /^[0-9a-f]{16}/.test(l.text))
				.map((l) => l.text.slice(0, 16)),
		}));

		// Verify no instruction address appears in more than one block
		const allAddresses = blockAddresses.flatMap((b) =>
			b.addresses.map((a) => ({ block: b.id, address: a })),
		);
		const seen = new Map<string, string>();
		for (const { block, address } of allAddresses) {
			const existing = seen.get(address);
			if (existing) {
				throw new Error(`Address ${address} in both ${existing} and ${block}`);
			}
			seen.set(address, block);
		}

		// Verify no duplicate edges (same from+to pair)
		const edgePairs = result.edges.map((e) => `${e.from}->${e.to}`);
		const uniquePairs = new Set(edgePairs);
		expect(edgePairs.length).toBe(uniquePairs.size);

		// Verify every non-terminal block has at least one outgoing edge
		const blockIds = new Set(result.blocks.map((b) => b.id));
		const blocksWithOutgoing = new Set(result.edges.map((e) => e.from));
		for (const block of result.blocks) {
			const lastLine = block.lines[block.lines.length - 1];
			const isTerminal =
				lastLine &&
				(/\bret\b/.test(lastLine.text) || /\bint3\b/.test(lastLine.text));
			if (!isTerminal) {
				expect(blocksWithOutgoing.has(block.id)).toBe(true);
			}
		}

		// Verify all edge targets reference existing blocks
		for (const edge of result.edges) {
			expect(blockIds.has(edge.from)).toBe(true);
			expect(blockIds.has(edge.to)).toBe(true);
		}
	});
});

const operandSegments = (
	...pairs: [string, InstrTextSegment["syntaxKind"]][]
): InstrTextSegment[] =>
	pairs.map(([text, syntaxKind]) => ({ text, syntaxKind }));

describe("buildCfgInstructionLine", () => {
	it("preserves the rendered graph line while exposing clickable tokens", () => {
		const line = buildCfgInstructionLine({
			address: 0x401000n,

			mnemonic: "mov",
			operandSegments: operandSegments(
				["qword ptr", "keyword"],
				[" ", "plain"],
				["[", "plain"],
				["rax", "register"],
				["+", "plain"],
				["0x20", "number"],
				["]", "plain"],
				[", ", "plain"],
				["rbx", "register"],
			),
		});

		expect(line.text).toBe("0000000000401000  mov qword ptr [rax+0x20], rbx");
		expect(
			line.segments
				.filter((segment) => segment.clickable)
				.map((segment) => segment.term),
		).toEqual(["0000000000401000", "mov", "qword ptr", "rax", "0x20", "rbx"]);
		expect(
			line.segments
				.filter((segment) => segment.clickable)
				.map((segment) => segment.syntaxKind),
		).toEqual(["plain", "mnemonic", "plain", "plain", "number", "plain"]);
	});
});

describe("buildCfgInstructionLines", () => {
	it("pads mnemonics so operand columns align within a block", () => {
		const lines = buildCfgInstructionLines([
			{
				address: 0x401000n,

				mnemonic: "mov",
				operandSegments: operandSegments(
					["rax", "register"],
					[", ", "plain"],
					["rbx", "register"],
				),
			},
			{
				address: 0x401002n,

				mnemonic: "cmovne",
				operandSegments: operandSegments(
					["rcx", "register"],
					[", ", "plain"],
					["rdx", "register"],
				),
			},
			{
				address: 0x401004n,

				mnemonic: "ret",
				operandSegments: [],
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
	it("emits each line as a single plain segment", () => {
		const lines = buildCfgTextLinesFromLabel(
			"missing memory\n0000000000001000",
		);

		expect(lines).toHaveLength(2);
		expect(lines.map((line) => line.text).join("\n")).toBe(
			"missing memory\n0000000000001000",
		);
		expect(lines[0]?.segments).toHaveLength(1);
		expect(lines[0]?.segments[0]?.clickable).toBe(false);
		expect(lines[1]?.segments).toHaveLength(1);
		expect(lines[1]?.segments[0]?.clickable).toBe(false);
	});
});
