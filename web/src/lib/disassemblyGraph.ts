import type { DebugInterface } from "./debug_interface";
import {
	type DecodedControlFlow,
	decodeInstruction,
	MAX_INSTRUCTION_LENGTH,
} from "./disassembly";
import { fmtHex16 } from "./formatting";
import { ZydisMnemonic } from "./mnemonic";

export type CfgEdgeKind = "true" | "false" | "unconditional";

export type CfgInstruction = {
	address: bigint;
	byteLength: number;
	prefix: string;
	mnemonic: string;
	operands: string;
	controlFlow: DecodedControlFlow;
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

export const ESTIMATED_CHAR_WIDTH = 7;
export const ESTIMATED_LINE_HEIGHT = 15;
export const CARD_PADDING_X = 16 + 2;
export const CARD_PADDING_Y = 12 + 2;
const TEXT_TOKEN_PATTERN = /[A-Za-z0-9_]+/g;

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

const mnemonicColumnWidth = (
	instruction: Pick<CfgInstruction, "prefix" | "mnemonic">,
) => {
	const prefixLen = instruction.prefix ? instruction.prefix.length + 1 : 0;
	return prefixLen + instruction.mnemonic.length;
};

export const buildCfgInstructionLine = (
	instruction: Pick<
		CfgInstruction,
		"address" | "prefix" | "mnemonic" | "operands"
	>,
	columnWidth = mnemonicColumnWidth(instruction),
): CfgTextLine => {
	const segments: CfgTextSegment[] = [
		makeTextSegment(fmtHex16(instruction.address), true, null, "plain"),
		makeTextSegment("  "),
	];

	if (instruction.prefix) {
		segments.push(
			makeTextSegment(`${instruction.prefix} `, true, null, "mnemonic"),
		);
	}

	segments.push(makeTextSegment(instruction.mnemonic, true, null, "mnemonic"));

	if (instruction.operands) {
		segments.push(
			makeTextSegment(
				" ".repeat(
					Math.max(1, columnWidth - mnemonicColumnWidth(instruction) + 1),
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
		"address" | "prefix" | "mnemonic" | "operands"
	>[],
) => {
	const maxColumnWidth = instructions.reduce(
		(maxWidth, instruction) =>
			Math.max(maxWidth, mnemonicColumnWidth(instruction)),
		0,
	);

	return instructions.map((instruction) =>
		buildCfgInstructionLine(instruction, maxColumnWidth),
	);
};

const buildBlock2 = async (
	dbg: DebugInterface,
	blockAddr: bigint,
	blocks: Map<bigint, CfgNode | null>,
	addPendingBlock: (addr: bigint) => void,
	addEdge: (to: bigint, kind: CfgEdgeKind) => void,
) => {
	const instructions: CfgInstruction[] = [];
	let ip = blockAddr;

	let error: string | null = null;
	loop: while (true) {
		if (instructions.length > 0 && blocks.has(ip)) {
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

		const decoded = decodeInstruction(bytes, ip);
		if (!decoded) {
			error = "decode error";
			break;
		}

		instructions.push({
			address: ip,
			byteLength: decoded.length,
			prefix: decoded.prefix,
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

		if (
			decoded.mnemonicId === ZydisMnemonic.ZYDIS_MNEMONIC_INT3 ||
			decoded.mnemonicId === ZydisMnemonic.ZYDIS_MNEMONIC_UD2
		) {
			break;
		}

		ip = nextIp;
	}

	const lines = buildCfgInstructionLines(instructions);
	if (error) {
		lines.push(...buildCfgTextLinesFromLabel(error));
	}

	blocks.set(blockAddr, {
		id: blockIdForAddress(blockAddr),
		title: fmtHex16(blockAddr),
		instructionCount: instructions.length,
		lines: lines,
	});
};

export const buildCfg2 = async (
	dbg: DebugInterface,
	entryAddress: bigint,
): Promise<CfgBuildResult> => {
	const blocks = new Map<bigint, CfgNode | null>();
	const edges = new Map<string, CfgEdge>();
	const pendingBlocks: bigint[] = [entryAddress];

	blocks.set(entryAddress, null);

	while (pendingBlocks.length > 0) {
		const addr = pendingBlocks.pop();

		const addPendingBlock = (newBlockAddr: bigint) => {
			if (addr === newBlockAddr || blocks.has(newBlockAddr)) {
				return;
			}

			blocks.set(newBlockAddr, null);
			pendingBlocks.push(newBlockAddr);
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

		await buildBlock2(dbg, addr, blocks, addPendingBlock, addEdge);
	}

	const allBlocks = Array.from(blocks.values()) as CfgNode[];

	return {
		anchorAddress: entryAddress,
		blocks: allBlocks,
		edges: Array.from(edges.values()),
		stats: {
			blockCount: allBlocks.length,
			edgeCount: edges.size,
			instructionCount: allBlocks.reduce(
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
