import type { DebugInterface } from "./debug_interface";
import {
	type DisassembledControlFlow,
	disassembleInstruction,
	MAX_INSTRUCTION_LENGTH,
} from "./disassembly";

export type CfgEdgeKind = "true" | "false" | "unconditional";

export type CfgInstruction = {
	address: bigint;
	byteLength: number;
	mnemonic: string;
	operands: string;
	controlFlow: DisassembledControlFlow;
};

export type CfgTextSegment = {
	text: string;
	clickable: boolean;
	term: string | null;
	syntaxKind: CfgTextSyntaxKind;
};

export type CfgTextSyntaxKind = "plain" | "mnemonic" | "number";

export type CfgTextLine = {
	text: string;
	segments: CfgTextSegment[];
};

export type CfgNode = {
	id: string;
	title: string;
	instructionCount: number;
	lines: CfgTextLine[];
};

export type CfgEdge = {
	id: string;
	from: string;
	to: string;
	kind: CfgEdgeKind;
};

export type CfgBuildOptions = {
	maxBlocks: number;
	maxEdges: number;
	maxInstructions: number;
};

export type CfgBuildStats = {
	blockCount: number;
	edgeCount: number;
	instructionCount: number;
	truncated: boolean;
};

export type CfgBuildResult = {
	anchorAddress: bigint;
	blocks: CfgNode[];
	edges: CfgEdge[];
	stats: CfgBuildStats;
};

const DEFAULT_CFG_BUILD_OPTIONS: CfgBuildOptions = {
	maxBlocks: 50_000,
	maxEdges: 200_000,
	maxInstructions: 1_000_000,
};

export const ESTIMATED_CHAR_WIDTH = 7;
export const ESTIMATED_LINE_HEIGHT = 15;
export const CARD_PADDING_X = 16 + 2;
export const CARD_PADDING_Y = 12 + 2;
const TEXT_TOKEN_PATTERN = /[A-Za-z0-9_]+/g;

const fmtAddress = (value: bigint) =>
	value.toString(16).toUpperCase().padStart(16, "0");

const joinTextSegments = (segments: readonly CfgTextSegment[]) =>
	segments.map((segment) => segment.text).join("");

const isNumericCfgToken = (token: string) =>
	/^0x[0-9a-f]+$/i.test(token) ||
	/^\d+$/.test(token) ||
	/^(?=.*\d)[0-9a-f]+h?$/i.test(token);

const makeTextSegment = (
	text: string,
	clickable = false,
	term: string | null = null,
	syntaxKind: CfgTextSyntaxKind = "plain",
): CfgTextSegment => ({
	text,
	clickable,
	term: clickable ? (term ?? text) : null,
	syntaxKind,
});

const blockIdForAddress = (address: bigint) => `block:${address.toString(16)}`;

export const tokenizeCfgTextSegments = (text: string): CfgTextSegment[] => {
	if (!text) {
		return [];
	}

	const segments: CfgTextSegment[] = [];
	let lastIndex = 0;
	for (const match of text.matchAll(TEXT_TOKEN_PATTERN)) {
		const [token] = match;
		const matchIndex = match.index ?? -1;
		if (matchIndex < 0) {
			continue;
		}

		if (matchIndex > lastIndex) {
			segments.push(makeTextSegment(text.slice(lastIndex, matchIndex)));
		}
		segments.push(
			makeTextSegment(
				token,
				true,
				null,
				isNumericCfgToken(token) ? "number" : "plain",
			),
		);
		lastIndex = matchIndex + token.length;
	}

	if (lastIndex < text.length) {
		segments.push(makeTextSegment(text.slice(lastIndex)));
	}

	return segments;
};

export const buildCfgInstructionLine = (
	instruction: Pick<CfgInstruction, "address" | "mnemonic" | "operands">,
	mnemonicColumnWidth = instruction.mnemonic.length,
): CfgTextLine => {
	const segments: CfgTextSegment[] = [
		makeTextSegment(fmtAddress(instruction.address), true, null, "plain"),
		makeTextSegment("  "),
		makeTextSegment(instruction.mnemonic, true, null, "mnemonic"),
	];

	if (instruction.operands) {
		segments.push(
			makeTextSegment(
				" ".repeat(
					Math.max(1, mnemonicColumnWidth - instruction.mnemonic.length + 1),
				),
			),
		);
		segments.push(...tokenizeCfgTextSegments(instruction.operands));
	}

	return {
		text: joinTextSegments(segments),
		segments,
	};
};

export const buildCfgTextLinesFromLabel = (label: string): CfgTextLine[] =>
	label.split("\n").map((line) => ({
		text: line,
		segments: tokenizeCfgTextSegments(line),
	}));

export const buildCfgInstructionLines = (
	instructions: readonly Pick<
		CfgInstruction,
		"address" | "mnemonic" | "operands"
	>[],
) => {
	const mnemonicColumnWidth = instructions.reduce(
		(maxWidth, instruction) => Math.max(maxWidth, instruction.mnemonic.length),
		0,
	);

	return instructions.map((instruction) =>
		buildCfgInstructionLine(instruction, mnemonicColumnWidth),
	);
};

const buildBlock2 = async (
	dbg: DebugInterface,
	blockAddr: bigint,
	blocks: Map<bigint, CfgNode>,
	knownBlockStarts: Set<bigint>,
	addPendingBlock: (addr: bigint) => void,
	addEdge: (to: bigint, kind: CfgEdgeKind) => void,
) => {
	const instructions: CfgInstruction[] = [];
	let ip = blockAddr;

	let error: string | null = null;
	loop: while (true) {
		if (instructions.length > 0 && knownBlockStarts.has(ip)) {
			addEdge(ip, "unconditional");
			break;
		}

		let bytes: Uint8Array;
		try {
			bytes = await dbg.read(ip, MAX_INSTRUCTION_LENGTH, 1);
		} catch {
			error = "missing memory";
			break;
		}

		const decoded = disassembleInstruction(bytes, ip);
		if (!decoded) {
			error = "decode error";
			break;
		}

		instructions.push({
			address: ip,
			byteLength: decoded.length,
			mnemonic: decoded.mnemonic,
			operands: decoded.operands,
			controlFlow: decoded.controlFlow,
		});

		const nextIp = ip + BigInt(decoded.length);
		const targetAddress = decoded.controlFlow.directTargetAddress;
		switch (decoded.controlFlow.kind) {
			case "conditional_branch": {
				if (targetAddress !== null) {
					addEdge(decoded.controlFlow.directTargetAddress, "true");
					addPendingBlock(decoded.controlFlow.directTargetAddress);
				}

				addEdge(nextIp, "false");
				addPendingBlock(nextIp);
				break loop;
			}
			case "unconditional_branch": {
				if (targetAddress !== null) {
					addEdge(targetAddress, "unconditional");
					addPendingBlock(targetAddress);
				}
				break loop;
			}
			case "return":
				break loop;
		}

		// treat INT3 and UD2 as terminators.
		if (decoded.mnemonic === "int3" || decoded.mnemonic === "ud2") {
			break;
		}

		ip = nextIp;
	}

	const lines = buildCfgInstructionLines(instructions);
	if (error) {
		lines.push(
			...buildCfgTextLinesFromLabel(
				error === "decode_error" ? "decode error" : "missing memory",
			),
		);
	}

	blocks.set(blockAddr, {
		id: blockIdForAddress(blockAddr),
		title: fmtAddress(blockAddr),
		instructionCount: instructions.length,
		lines: lines,
	});
};

export const buildCfg2 = async (
	dbg: DebugInterface,
	entryAddress: bigint,
): Promise<CfgBuildResult> => {
	const blocks = new Map<bigint, CfgNode>();
	const edges = new Map<string, CfgEdge>();
	const pendingBlocks = new Set<bigint>([entryAddress]);
	const knownBlockStarts = new Set<bigint>([entryAddress]);

	while (pendingBlocks.size > 0) {
		// pop the first pending block
		const addr = pendingBlocks.values().next().value;
		pendingBlocks.delete(addr);

		const addPendingBlock = (newBlockAddr: bigint) => {
			if (
				addr === newBlockAddr ||
				blocks.has(newBlockAddr) ||
				knownBlockStarts.has(newBlockAddr)
			) {
				return;
			}

			knownBlockStarts.add(newBlockAddr);
			pendingBlocks.add(newBlockAddr);
		};

		const addEdge = (to: bigint, kind: CfgEdgeKind) => {
			const id = `${addr}->${to}:${kind}`;
			if (!edges.has(id)) {
				edges.set(id, {
					id,
					from: blockIdForAddress(addr),
					to: blockIdForAddress(to),
					kind,
				});
			}
		};

		await buildBlock2(
			dbg,
			addr,
			blocks,
			knownBlockStarts,
			addPendingBlock,
			addEdge,
		);
	}

	return {
		anchorAddress: entryAddress,
		blocks: Array.from(blocks.values()),
		edges: Array.from(edges.values()),
		stats: {
			blockCount: blocks.size,
			edgeCount: edges.size,
			instructionCount: Array.from(blocks.values()).reduce(
				(total, block) => total + block.instructionCount,
				0,
			),
			truncated: false,
		},
	};
};

export const estimateNodeDimensions = (node: CfgNode) => {
	const maxLineLength = node.lines.reduce(
		(maxLength, line) => Math.max(maxLength, line.text.length),
		0,
	);
	const height =
		CARD_PADDING_Y + Math.max(node.lines.length, 2) * ESTIMATED_LINE_HEIGHT;
	const width = CARD_PADDING_X + maxLineLength * ESTIMATED_CHAR_WIDTH;
	return { width, height };
};
