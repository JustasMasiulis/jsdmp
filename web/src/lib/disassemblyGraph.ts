import type { DisassemblyMemorySource } from "./debugDisassembly";
import {
	type DisassembledControlFlow,
	disassembleInstruction,
	MAX_INSTRUCTION_LENGTH,
} from "./disassembly";

export type CfgBuildStatus =
	| "ok"
	| "missing_memory"
	| "decode_error"
	| "truncated";

export type CfgNodeKind = "block" | "missing_memory" | "decode_error";
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
	kind: CfgNodeKind;
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
	status: CfgBuildStatus;
	message: string;
	anchorAddress: bigint;
	blocks: CfgNode[];
	edges: CfgEdge[];
	stats: CfgBuildStats;
};

export type CfgInstructionDecoder = (
	source: DisassemblyMemorySource,
	address: bigint,
) => CfgInstruction | null;

type SyntheticSuccessor = {
	address: bigint;
	key: string;
	kind: Exclude<CfgNodeKind, "block">;
};

type PendingSuccessor = {
	kind: CfgEdgeKind;
	target: bigint | SyntheticSuccessor;
};

type CfgBuildState = {
	instructionCount: number;
	truncated: boolean;
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

const syntheticNodeId = (kind: CfgNodeKind, key: string) =>
	`synthetic:${kind}:${key}`;

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
		// Keep addresses searchable/clickable without giving them number styling.
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

const makeSyntheticSuccessor = (
	edgeKind: CfgEdgeKind,
	kind: Exclude<CfgNodeKind, "block">,
	address: bigint,
): PendingSuccessor => ({
	kind: edgeKind,
	target: {
		address,
		key: fmtAddress(address),
		kind,
	},
});

const buildSyntheticNode = (
	kind: Exclude<CfgNodeKind, "block">,
	key: string,
	address: bigint,
): CfgNode => {
	const title = kind === "missing_memory" ? "missing memory" : "decode error";
	return {
		id: syntheticNodeId(kind, key),
		kind,
		title,
		instructionCount: 0,
		lines: buildCfgTextLinesFromLabel(`${title}\n${fmtAddress(address)}`),
	};
};

export const decodeInstructionForCfg: CfgInstructionDecoder = (
	source,
	address,
) => {
	const bytes = source.readMemoryAt(address, MAX_INSTRUCTION_LENGTH);
	if (!bytes || bytes.byteLength === 0) {
		return null;
	}

	const decoded = disassembleInstruction(bytes, address);
	if (!decoded) {
		return null;
	}

	return {
		address,
		byteLength: decoded.length,
		mnemonic: decoded.mnemonic,
		operands: decoded.operands,
		controlFlow: decoded.controlFlow,
	};
};

const buildBlock = (
	source: DisassemblyMemorySource,
	startAddress: bigint,
	decoder: CfgInstructionDecoder,
	knownBlockStarts: Set<bigint>,
	state: CfgBuildState,
	options: CfgBuildOptions,
): { block: CfgNode | null; successors: PendingSuccessor[] } => {
	const instructions: CfgInstruction[] = [];
	const successors: PendingSuccessor[] = [];
	let cursor = startAddress;

	blockLoop: while (true) {
		if (state.instructionCount >= options.maxInstructions) {
			state.truncated = true;
			break;
		}

		if (instructions.length > 0 && knownBlockStarts.has(cursor)) {
			successors.push({ kind: "unconditional", target: cursor });
			break;
		}

		const instruction = decoder(source, cursor);
		if (!instruction) {
			if (instructions.length === 0) {
				return { block: null, successors };
			}

			successors.push(
				makeSyntheticSuccessor("unconditional", "decode_error", cursor),
			);
			break;
		}

		instructions.push(instruction);
		state.instructionCount += 1;
		const nextAddress = cursor + BigInt(instruction.byteLength);

		switch (instruction.controlFlow.kind) {
			case "conditional_branch":
				if (instruction.controlFlow.directTargetAddress !== null) {
					successors.push({
						kind: "true",
						target: instruction.controlFlow.directTargetAddress,
					});
				}
				successors.push(
					source.findMemoryRangeAt(nextAddress)
						? { kind: "false", target: nextAddress }
						: makeSyntheticSuccessor("false", "missing_memory", nextAddress),
				);
				break blockLoop;
			case "unconditional_branch":
			case "return":
				if (instruction.controlFlow.directTargetAddress !== null) {
					successors.push({
						kind: "unconditional",
						target: instruction.controlFlow.directTargetAddress,
					});
				}
				break blockLoop;
		}

		if (!source.findMemoryRangeAt(nextAddress)) {
			successors.push(
				makeSyntheticSuccessor("unconditional", "missing_memory", nextAddress),
			);
			break;
		}

		cursor = nextAddress;
	}

	if (instructions.length === 0) {
		return { block: null, successors };
	}

	return {
		block: {
			id: blockIdForAddress(startAddress),
			kind: "block",
			title: fmtAddress(startAddress),
			instructionCount: instructions.length,
			lines: buildCfgInstructionLines(instructions),
		},
		successors,
	};
};

export const buildControlFlowGraph = (
	source: DisassemblyMemorySource,
	anchorAddress: bigint,
	options?: Partial<CfgBuildOptions>,
	decoder: CfgInstructionDecoder = decodeInstructionForCfg,
): CfgBuildResult => {
	const mergedOptions = { ...DEFAULT_CFG_BUILD_OPTIONS, ...options };
	if (!source.findMemoryRangeAt(anchorAddress)) {
		return {
			status: "missing_memory",
			message: `Address ${fmtAddress(anchorAddress)} is not present in dump memory.`,
			anchorAddress,
			blocks: [],
			edges: [],
			stats: {
				blockCount: 0,
				edgeCount: 0,
				instructionCount: 0,
				truncated: false,
			},
		};
	}

	const pendingStarts = [anchorAddress];
	const knownBlockStarts = new Set(pendingStarts);
	const nodes: CfgNode[] = [];
	const blockMap = new Map<string, CfgNode>();
	const syntheticMap = new Map<string, CfgNode>();
	const aliasMap = new Map<string, string>();
	const edgeMap = new Map<string, CfgEdge>();
	const state: CfgBuildState = { instructionCount: 0, truncated: false };
	let anchorDecodeFailed = false;

	const ensureSyntheticNode = (
		kind: Exclude<CfgNodeKind, "block">,
		key: string,
		address: bigint,
	) => {
		const id = syntheticNodeId(kind, key);
		const existing = syntheticMap.get(id);
		if (existing) {
			return existing;
		}

		const node = buildSyntheticNode(kind, key, address);
		syntheticMap.set(id, node);
		nodes.push(node);
		return node;
	};

	const enqueueStart = (address: bigint) => {
		const blockId = blockIdForAddress(address);
		if (blockMap.has(blockId) || knownBlockStarts.has(address)) {
			return;
		}

		knownBlockStarts.add(address);
		pendingStarts.push(address);
	};

	const addEdge = (from: string, to: string, kind: CfgEdgeKind) => {
		if (edgeMap.size >= mergedOptions.maxEdges) {
			state.truncated = true;
			return;
		}

		const id = `${from}->${to}:${kind}`;
		if (!edgeMap.has(id)) {
			edgeMap.set(id, { id, from, to, kind });
		}
	};

	while (pendingStarts.length > 0) {
		if (blockMap.size >= mergedOptions.maxBlocks) {
			state.truncated = true;
			break;
		}
		if (state.instructionCount >= mergedOptions.maxInstructions) {
			state.truncated = true;
			break;
		}

		const startAddress = pendingStarts.shift();
		if (startAddress === undefined) {
			break;
		}

		const { block, successors } = buildBlock(
			source,
			startAddress,
			decoder,
			knownBlockStarts,
			state,
			mergedOptions,
		);
		const blockId = blockIdForAddress(startAddress);

		if (!block) {
			const errorNode = ensureSyntheticNode(
				"decode_error",
				fmtAddress(startAddress),
				startAddress,
			);
			aliasMap.set(blockId, errorNode.id);
			if (startAddress === anchorAddress) {
				anchorDecodeFailed = true;
			}
			continue;
		}

		blockMap.set(block.id, block);
		nodes.push(block);

		for (const successor of successors) {
			if (typeof successor.target !== "bigint") {
				const node = ensureSyntheticNode(
					successor.target.kind,
					successor.target.key,
					successor.target.address,
				);
				addEdge(block.id, node.id, successor.kind);
				continue;
			}

			const targetAddress = successor.target;
			if (!source.findMemoryRangeAt(targetAddress)) {
				const node = ensureSyntheticNode(
					"missing_memory",
					fmtAddress(targetAddress),
					targetAddress,
				);
				addEdge(block.id, node.id, successor.kind);
				continue;
			}

			addEdge(block.id, blockIdForAddress(targetAddress), successor.kind);
			enqueueStart(targetAddress);
		}
	}

	const nodeIds = new Set(nodes.map((node) => node.id));
	const resolvedEdgeIds = new Set<string>();
	const resolvedEdges: CfgEdge[] = [];

	for (const edge of edgeMap.values()) {
		const targetId = aliasMap.get(edge.to) ?? edge.to;
		if (!nodeIds.has(targetId)) {
			continue;
		}

		const id = `${edge.from}->${targetId}:${edge.kind}`;
		if (resolvedEdgeIds.has(id)) {
			continue;
		}

		resolvedEdgeIds.add(id);
		resolvedEdges.push(
			targetId === edge.to
				? edge
				: {
						...edge,
						id,
						to: targetId,
					},
		);
	}

	const status: CfgBuildStatus = anchorDecodeFailed
		? "decode_error"
		: state.truncated
			? "truncated"
			: "ok";

	const message =
		status === "decode_error"
			? `Failed to decode an instruction at ${fmtAddress(anchorAddress)}.`
			: status === "truncated"
				? `Graph from ${fmtAddress(anchorAddress)} was truncated at configured limits.`
				: `Showing graph from ${fmtAddress(anchorAddress)}.`;

	return {
		status,
		message,
		anchorAddress,
		blocks: nodes,
		edges: resolvedEdges,
		stats: {
			blockCount: blockMap.size,
			edgeCount: resolvedEdges.length,
			instructionCount: state.instructionCount,
			truncated: state.truncated,
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
