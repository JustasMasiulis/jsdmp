import { describe, expect, it } from "bun:test";
import {
	buildControlFlowGraph,
	layoutControlFlowGraph,
	type CfgInstruction,
	type CfgInstructionDecoder,
} from "./disassemblyGraph";
import type { DisassembledControlFlow } from "./disassembly";
import type {
	MinidumpMemory64Range,
	MinidumpMemoryRangeMatch,
} from "./minidump";

const range = (address: bigint, dataSize: bigint): MinidumpMemory64Range => ({
	address,
	dataSize,
	dataRva: 0n,
});

const controlFlow = (
	kind: DisassembledControlFlow["kind"],
	overrides: Partial<DisassembledControlFlow> = {},
): DisassembledControlFlow => ({
	kind,
	hasFallthrough: kind === "none" || kind === "call" || kind === "conditional_branch",
	hasDirectTarget: false,
	directTargetAddress: null,
	...overrides,
});

const instruction = (
	address: bigint,
	byteLength: number,
	mnemonic: string,
	operands: string,
	flow: DisassembledControlFlow,
): CfgInstruction => ({
	address,
	byteLength,
	bytesHex: "90",
	mnemonic,
	operands,
	text: operands ? `${mnemonic} ${operands}` : mnemonic,
	controlFlow: flow,
});

const keyFor = (address: bigint) => address.toString(16);

const createSource = (
	ranges: MinidumpMemory64Range[],
	instructions: CfgInstruction[],
): {
	source: {
		readMemoryAt: (address: bigint, size: number) => Uint8Array | null;
		findMemoryRangeAt: (
			address: bigint,
			hintRangeIndex?: number,
		) => MinidumpMemoryRangeMatch | null;
	};
	decoder: CfgInstructionDecoder;
} => {
	const instructionMap = new Map(
		instructions.map((entry) => [keyFor(entry.address), entry] as const),
	);

	return {
		source: {
			readMemoryAt: (address, size) => {
				const match = ranges.find(
					(candidate) =>
						address >= candidate.address &&
						address + BigInt(size) <= candidate.address + candidate.dataSize,
				);
				return match ? new Uint8Array(size) : null;
			},
			findMemoryRangeAt: (address) => {
				const index = ranges.findIndex(
					(candidate) =>
						address >= candidate.address &&
						address < candidate.address + candidate.dataSize,
				);
				if (index < 0) {
					return null;
				}
				return {
					index,
					range: ranges[index],
				};
			},
		},
		decoder: (_source, address) => instructionMap.get(keyFor(address)) ?? null,
	};
};

const blockAt = (result: ReturnType<typeof buildControlFlowGraph>, address: bigint) =>
	result.blocks.find((block) => block.startAddress === address);

describe("buildControlFlowGraph", () => {
	it("builds a straight-line block ending in an unconditional jump", () => {
		const { source, decoder } = createSource(
			[range(0x1000n, 0x10n), range(0x2000n, 0x10n)],
			[
				instruction(0x1000n, 1, "nop", "", controlFlow("none")),
				instruction(
					0x1001n,
					2,
					"jmp",
					"0x2000",
					controlFlow("unconditional_branch", {
						hasFallthrough: false,
						hasDirectTarget: true,
						directTargetAddress: 0x2000n,
					}),
				),
				instruction(
					0x2000n,
					1,
					"ret",
					"",
					controlFlow("return", { hasFallthrough: false }),
				),
			],
		);

		const result = buildControlFlowGraph(source, 0x1000n, undefined, decoder);
		expect(result.status).toBe("ok");
		expect(result.stats.blockCount).toBe(2);
		expect(blockAt(result, 0x1000n)?.instructions).toHaveLength(2);
		expect(result.edges.some((edge) => edge.kind === "branch")).toBe(true);
	});

	it("creates conditional branch and fallthrough successors", () => {
		const { source, decoder } = createSource(
			[range(0x1000n, 0x10n), range(0x2000n, 0x10n)],
			[
				instruction(0x1000n, 1, "cmp", "eax, ebx", controlFlow("none")),
				instruction(
					0x1001n,
					2,
					"jne",
					"0x2000",
					controlFlow("conditional_branch", {
						hasDirectTarget: true,
						directTargetAddress: 0x2000n,
					}),
				),
				instruction(
					0x1003n,
					1,
					"ret",
					"",
					controlFlow("return", { hasFallthrough: false }),
				),
				instruction(
					0x2000n,
					1,
					"ret",
					"",
					controlFlow("return", { hasFallthrough: false }),
				),
			],
		);

		const result = buildControlFlowGraph(source, 0x1000n, undefined, decoder);
		expect(result.stats.blockCount).toBe(3);
		expect(result.edges.filter((edge) => edge.kind === "branch")).toHaveLength(1);
		expect(result.edges.filter((edge) => edge.kind === "fallthrough")).toHaveLength(1);
	});

	it("follows a real jump target below the anchor address", () => {
		const { source, decoder } = createSource(
			[range(0x1FF0n, 0x20n)],
			[
				instruction(0x2000n, 1, "dec", "eax", controlFlow("none")),
				instruction(
					0x2001n,
					2,
					"jne",
					"0x1FF0",
					controlFlow("conditional_branch", {
						hasDirectTarget: true,
						directTargetAddress: 0x1FF0n,
					}),
				),
				instruction(
					0x2003n,
					1,
					"ret",
					"",
					controlFlow("return", { hasFallthrough: false }),
				),
				instruction(
					0x1FF0n,
					1,
					"ret",
					"",
					controlFlow("return", { hasFallthrough: false }),
				),
			],
		);

		const result = buildControlFlowGraph(source, 0x2000n, undefined, decoder);
		expect(result.blocks.some((block) => block.startAddress === 0x1FF0n)).toBe(true);
	});

	it("keeps call instructions inside the current block", () => {
		const { source, decoder } = createSource(
			[range(0x1000n, 0x20n), range(0x3000n, 0x10n)],
			[
				instruction(
					0x1000n,
					5,
					"call",
					"0x3000",
					controlFlow("call", {
						hasDirectTarget: true,
						directTargetAddress: 0x3000n,
					}),
				),
				instruction(0x1005n, 1, "nop", "", controlFlow("none")),
				instruction(
					0x1006n,
					2,
					"jmp",
					"0x100A",
					controlFlow("unconditional_branch", {
						hasFallthrough: false,
						hasDirectTarget: true,
						directTargetAddress: 0x100An,
					}),
				),
				instruction(
					0x100An,
					1,
					"ret",
					"",
					controlFlow("return", { hasFallthrough: false }),
				),
			],
		);

		const result = buildControlFlowGraph(source, 0x1000n, undefined, decoder);
		expect(blockAt(result, 0x1000n)?.instructions.map((entry) => entry.mnemonic)).toEqual([
			"call",
			"nop",
			"jmp",
		]);
		expect(result.blocks.some((block) => block.startAddress === 0x3000n)).toBe(false);
	});

	it("creates an unknown exit node for indirect terminators", () => {
		const { source, decoder } = createSource(
			[range(0x1000n, 0x10n)],
			[
				instruction(0x1000n, 1, "mov", "rax, rbx", controlFlow("none")),
				instruction(
					0x1001n,
					2,
					"jmp",
					"rax",
					controlFlow("unconditional_branch", {
						hasFallthrough: false,
					}),
				),
			],
		);

		const result = buildControlFlowGraph(source, 0x1000n, undefined, decoder);
		expect(result.blocks.some((block) => block.kind === "unknown_exit")).toBe(true);
		expect(result.edges.some((edge) => edge.kind === "unknown")).toBe(true);
	});

	it("marks the graph truncated when limits are hit", () => {
		const { source, decoder } = createSource(
			[range(0x1000n, 0x40n)],
			[
				instruction(
					0x1000n,
					2,
					"jmp",
					"0x1010",
					controlFlow("unconditional_branch", {
						hasFallthrough: false,
						hasDirectTarget: true,
						directTargetAddress: 0x1010n,
					}),
				),
				instruction(
					0x1010n,
					2,
					"jmp",
					"0x1020",
					controlFlow("unconditional_branch", {
						hasFallthrough: false,
						hasDirectTarget: true,
						directTargetAddress: 0x1020n,
					}),
				),
				instruction(
					0x1020n,
					1,
					"ret",
					"",
					controlFlow("return", { hasFallthrough: false }),
				),
			],
		);

		const result = buildControlFlowGraph(
			source,
			0x1000n,
			{ maxBlocks: 1 },
			decoder,
		);
		expect(result.status).toBe("truncated");
		expect(result.blocks.some((block) => block.kind === "truncated")).toBe(true);
	});

	it("follows direct targets across memory ranges", () => {
		const { source, decoder } = createSource(
			[range(0x1000n, 0x10n), range(0x5000n, 0x10n)],
			[
				instruction(
					0x1000n,
					2,
					"jmp",
					"0x5000",
					controlFlow("unconditional_branch", {
						hasFallthrough: false,
						hasDirectTarget: true,
						directTargetAddress: 0x5000n,
					}),
				),
				instruction(
					0x5000n,
					1,
					"ret",
					"",
					controlFlow("return", { hasFallthrough: false }),
				),
			],
		);

		const result = buildControlFlowGraph(source, 0x1000n, undefined, decoder);
		expect(result.blocks.some((block) => block.startAddress === 0x5000n)).toBe(true);
	});
	it("produces finite node coordinates even if a node carries invalid layout metadata", () => {
		const laidOut = layoutControlFlowGraph({
			status: "ok",
			message: "",
			anchorAddress: 0x1000n,
			anchorNodeId: "block:1000",
			blocks: [
				{
					id: "block:1000",
					kind: "block",
					discoveryIndex: 0,
					startAddress: 0x1000n,
					endAddressExclusive: 0x1001n,
					instructions: [],
					title: "1000",
					label: "1000",
					lineCount: Number.NaN,
				},
			],
			edges: [],
			stats: {
				blockCount: 1,
				edgeCount: 0,
				instructionCount: 0,
				truncated: false,
			},
		});

		expect(laidOut.nodes).toHaveLength(1);
		expect(Number.isFinite(laidOut.nodes[0].x)).toBe(true);
		expect(Number.isFinite(laidOut.nodes[0].y)).toBe(true);
	});

	it("spaces blocks in the same column far enough apart to avoid card overlap", () => {
		const laidOut = layoutControlFlowGraph({
			status: "ok",
			message: "",
			anchorAddress: 0x1000n,
			anchorNodeId: "block:1000",
			blocks: [
				{
					id: "block:1000",
					kind: "block",
					discoveryIndex: 0,
					startAddress: 0x1000n,
					endAddressExclusive: 0x1002n,
					instructions: [],
					title: "0x1000",
					label: "0x1000\n0x1000  jne 0x2000",
					lineCount: 2,
				},
				{
					id: "block:2000",
					kind: "block",
					discoveryIndex: 1,
					startAddress: 0x2000n,
					endAddressExclusive: 0x2005n,
					instructions: [],
					title: "0x2000",
					label:
						"0x2000\n0x2000  mov eax, [rbx + rcx * 4]\n0x2004  add eax, edx\n0x2006  jne 0x3000",
					lineCount: 4,
				},
				{
					id: "block:2008",
					kind: "block",
					discoveryIndex: 2,
					startAddress: 0x2008n,
					endAddressExclusive: 0x200Cn,
					instructions: [],
					title: "0x2008",
					label:
						"0x2008\n0x2008  mov rcx, [rsp + 0x20]\n0x200C  test rcx, rcx\n0x200F  jne 0x3010",
					lineCount: 4,
				},
			],
			edges: [
				{
					id: "block:1000->block:2000:branch",
					from: "block:1000",
					to: "block:2000",
					kind: "branch",
					isBackedge: false,
				},
				{
					id: "block:1000->block:2008:fallthrough",
					from: "block:1000",
					to: "block:2008",
					kind: "fallthrough",
					isBackedge: false,
				},
			],
			stats: {
				blockCount: 3,
				edgeCount: 2,
				instructionCount: 0,
				truncated: false,
			},
		});

		const upper = laidOut.nodes.find((node) => node.id === "block:2000");
		const lower = laidOut.nodes.find((node) => node.id === "block:2008");
		expect(upper).toBeDefined();
		expect(lower).toBeDefined();
		expect(upper?.depth).toBe(1);
		expect(lower?.depth).toBe(1);
		expect(Math.abs((upper?.y ?? 0) - (lower?.y ?? 0))).toBeGreaterThanOrEqual(
			((upper?.height ?? 0) + (lower?.height ?? 0)) / 2,
		);
		expect(upper?.compactLabel).toBe("0x2000");
		expect(upper?.fullLabel).toContain("mov eax");
	});
});
