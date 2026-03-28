import { describe, expect, it } from "bun:test";
import type { DisassemblyMemorySource } from "./debugDisassembly";
import type { DisassembledControlFlow } from "./disassembly";
import {
	buildCfgInstructionLine,
	buildCfgInstructionLines,
	buildCfgTextLinesFromLabel,
	buildControlFlowGraph,
	type CfgInstruction,
	type CfgInstructionDecoder,
	tokenizeCfgTextSegments,
} from "./disassemblyGraph";

type FakeRange = {
	start: bigint;
	endExclusive: bigint;
};

const makeSource = (ranges: FakeRange[]): DisassemblyMemorySource => ({
	readMemoryAt: () => new Uint8Array([0xc3]),
	findMemoryRangeAt: (address) => {
		const index = ranges.findIndex(
			(range) => address >= range.start && address < range.endExclusive,
		);
		if (index < 0) {
			return null;
		}

		const range = ranges[index];
		return {
			index,
			range: {
				address: range.start,
				dataSize: range.endExclusive - range.start,
				dataRva: 0n,
			},
		};
	},
});

const makeInstruction = (
	address: bigint,
	controlFlow: DisassembledControlFlow = {
		kind: "return",
		directTargetAddress: null,
	},
): CfgInstruction => ({
	address,
	byteLength: 1,
	bytesHex: "C3",
	mnemonic: "ret",
	operands: "",
	text: "ret",
	controlFlow,
});

describe("buildControlFlowGraph", () => {
	it("does not expose an anchor-specific node id on successful builds", () => {
		const anchorAddress = 0x1000n;
		const source = makeSource([
			{ start: anchorAddress, endExclusive: 0x1002n },
		]);
		const decoder: CfgInstructionDecoder = (_, address) =>
			address === anchorAddress ? makeInstruction(address) : null;

		const result = buildControlFlowGraph(
			source,
			anchorAddress,
			undefined,
			decoder,
		);

		expect(result.status).toBe("ok");
		expect("anchorNodeId" in result).toBe(false);
		expect(result.blocks).toHaveLength(1);
		expect(result.blocks[0]?.id).toBe("block:1000");
	});

	it("still reports decode_error when the anchor address cannot be decoded", () => {
		const anchorAddress = 0x2000n;
		const source = makeSource([
			{ start: anchorAddress, endExclusive: 0x2001n },
		]);
		const decoder: CfgInstructionDecoder = () => null;

		const result = buildControlFlowGraph(
			source,
			anchorAddress,
			undefined,
			decoder,
		);

		expect(result.status).toBe("decode_error");
		expect(result.blocks).toHaveLength(1);
		expect(result.blocks[0]?.kind).toBe("decode_error");
		expect(result.message).toContain("Failed to decode an instruction");
	});

	it("returns missing_memory when the anchor address is outside dump memory", () => {
		const result = buildControlFlowGraph(
			makeSource([]),
			0x3000n,
			undefined,
			() => makeInstruction(0x3000n),
		);

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
			"number",
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
