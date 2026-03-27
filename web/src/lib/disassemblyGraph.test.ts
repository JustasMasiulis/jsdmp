import { describe, expect, it } from "bun:test";
import type { DisassemblyMemorySource } from "./debugDisassembly";
import type { DisassembledControlFlow } from "./disassembly";
import {
	buildControlFlowGraph,
	type CfgInstruction,
	type CfgInstructionDecoder,
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
