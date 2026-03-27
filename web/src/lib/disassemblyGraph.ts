import type { DisassemblyMemorySource } from "./debugDisassembly";
import {
	type DisassembledControlFlow,
	disassembleInstruction,
	MAX_INSTRUCTION_LENGTH,
} from "./disassembly";

type Mutable<T> = {
	-readonly [K in keyof T]: T[K];
};

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
	bytesHex: string;
	mnemonic: string;
	operands: string;
	text: string;
	controlFlow: DisassembledControlFlow;
};

export type CfgNode = {
	id: string;
	kind: CfgNodeKind;
	discoveryIndex: number;
	startAddress: bigint | null;
	endAddressExclusive: bigint | null;
	instructions: CfgInstruction[];
	title: string;
	label: string;
	lineCount: number;
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
	anchorNodeId: string | null;
	blocks: CfgNode[];
	edges: CfgEdge[];
	stats: CfgBuildStats;
};

export type CfgInstructionDecoder = (
	source: DisassemblyMemorySource,
	address: bigint,
) => CfgInstruction | null;

type PendingSuccessor = {
	kind: CfgEdgeKind;
	targetAddress: bigint | null;
	syntheticKind: CfgNodeKind | null;
	syntheticKey: string | null;
	syntheticTitle: string | null;
	syntheticLabel: string | null;
	syntheticAddress: bigint | null;
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
export const MIN_CARD_WIDTH = 156;
export const MIN_CARD_HEIGHT = 38;

const fmtAddress = (value: bigint) =>
	`${value.toString(16).toUpperCase().padStart(16, "0")}`;

const formatBytes = (bytes: Uint8Array) =>
	[...bytes]
		.map((value) => value.toString(16).toUpperCase().padStart(2, "0"))
		.join(" ");

const formatInstructionText = (
	instruction: Pick<CfgInstruction, "mnemonic" | "operands">,
) =>
	instruction.operands
		? `${instruction.mnemonic} ${instruction.operands}`
		: instruction.mnemonic;

const blockIdForAddress = (address: bigint) => `block:${address.toString(16)}`;

const syntheticNodeId = (kind: CfgNodeKind, key: string) =>
	`synthetic:${kind}:${key}`;

const mergeOptions = (options?: Partial<CfgBuildOptions>): CfgBuildOptions => ({
	...DEFAULT_CFG_BUILD_OPTIONS,
	...options,
});

const makeInstruction = (
	address: bigint,
	byteLength: number,
	bytesHex: string,
	mnemonic: string,
	operands: string,
	controlFlow: DisassembledControlFlow,
): CfgInstruction => ({
	address,
	byteLength,
	bytesHex,
	mnemonic,
	operands,
	text: formatInstructionText({ mnemonic, operands }),
	controlFlow,
});

const makeNode = (
	kind: CfgNodeKind,
	id: string,
	discoveryIndex: number,
	startAddress: bigint | null,
	endAddressExclusive: bigint | null,
	instructions: CfgInstruction[],
	title: string,
	label: string,
): CfgNode => ({
	id,
	kind,
	discoveryIndex,
	startAddress,
	endAddressExclusive,
	instructions,
	title,
	label,
	lineCount: label.split("\n").length,
});

const isBlockTerminator = (instruction: CfgInstruction) => {
	switch (instruction.controlFlow.kind) {
		case "conditional_branch":
		case "unconditional_branch":
		case "return":
			return true;
		default:
			return false;
	}
};

const buildBlockLabel = (instructions: CfgInstruction[]) =>
	[
		...instructions.map(
			(instruction) =>
				`${fmtAddress(instruction.address)}  ${instruction.text}`,
		),
	].join("\n");

const makeSyntheticSuccessor = (
	edgeKind: CfgEdgeKind,
	kind: CfgNodeKind,
	key: string,
	title: string,
	label: string,
	address: bigint | null,
): PendingSuccessor => ({
	kind: edgeKind,
	targetAddress: null,
	syntheticKind: kind,
	syntheticKey: key,
	syntheticTitle: title,
	syntheticLabel: label,
	syntheticAddress: address,
});

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

	return makeInstruction(
		address,
		decoded.length,
		formatBytes(decoded.bytes),
		decoded.mnemonic,
		decoded.operands,
		decoded.controlFlow,
	);
};

const buildBlock = (
	source: DisassemblyMemorySource,
	startAddress: bigint,
	decoder: CfgInstructionDecoder,
	knownBlockStarts: Set<bigint>,
	instructionCounter: Mutable<{ value: number }>,
	options: CfgBuildOptions,
	markTruncated: () => void,
): { block: CfgNode | null; successors: PendingSuccessor[] } => {
	const instructions: CfgInstruction[] = [];
	const successors: PendingSuccessor[] = [];
	let cursor = startAddress;

	while (true) {
		if (instructionCounter.value >= options.maxInstructions) {
			markTruncated();
			break;
		}

		if (instructions.length > 0 && knownBlockStarts.has(cursor)) {
			successors.push({
				kind: "unconditional",
				targetAddress: cursor,
				syntheticKind: null,
				syntheticKey: null,
				syntheticTitle: null,
				syntheticLabel: null,
				syntheticAddress: null,
			});
			break;
		}

		const decoded = decoder(source, cursor);
		if (!decoded) {
			if (instructions.length === 0) {
				return { block: null, successors };
			}

			successors.push(
				makeSyntheticSuccessor(
					"unconditional",
					"decode_error",
					`${fmtAddress(startAddress)}:${fmtAddress(cursor)}`,
					"decode error",
					`decode error\n${fmtAddress(cursor)}`,
					cursor,
				),
			);
			break;
		}

		instructions.push(decoded);
		instructionCounter.value += 1;
		const nextAddress = cursor + BigInt(decoded.byteLength);

		if (isBlockTerminator(decoded)) {
			const isConditional = decoded.controlFlow.kind === "conditional_branch";

			if (decoded.controlFlow.directTargetAddress !== null) {
				successors.push({
					kind: isConditional ? "true" : "unconditional",
					targetAddress: decoded.controlFlow.directTargetAddress,
					syntheticKind: null,
					syntheticKey: null,
					syntheticTitle: null,
					syntheticLabel: null,
					syntheticAddress: null,
				});
			}

			if (isConditional) {
				if (source.findMemoryRangeAt(nextAddress)) {
					successors.push({
						kind: "false",
						targetAddress: nextAddress,
						syntheticKind: null,
						syntheticKey: null,
						syntheticTitle: null,
						syntheticLabel: null,
						syntheticAddress: null,
					});
				} else {
					successors.push(
						makeSyntheticSuccessor(
							"false",
							"missing_memory",
							`${fmtAddress(startAddress)}:${fmtAddress(nextAddress)}`,
							"missing memory",
							`missing memory\n${fmtAddress(nextAddress)}`,
							nextAddress,
						),
					);
				}
			}
			break;
		}

		if (!source.findMemoryRangeAt(nextAddress)) {
			successors.push(
				makeSyntheticSuccessor(
					"unconditional",
					"missing_memory",
					`${fmtAddress(startAddress)}:${fmtAddress(nextAddress)}`,
					"missing memory",
					`missing memory\n${fmtAddress(nextAddress)}`,
					nextAddress,
				),
			);
			break;
		}

		cursor = nextAddress;
	}

	if (instructions.length === 0) {
		return { block: null, successors };
	}

	const lastInstruction = instructions[instructions.length - 1];
	const endAddressExclusive =
		lastInstruction.address + BigInt(lastInstruction.byteLength);

	return {
		block: makeNode(
			"block",
			blockIdForAddress(startAddress),
			0,
			startAddress,
			endAddressExclusive,
			instructions,
			fmtAddress(startAddress),
			buildBlockLabel(instructions),
		),
		successors,
	};
};

export const buildControlFlowGraph = (
	source: DisassemblyMemorySource,
	anchorAddress: bigint,
	options?: Partial<CfgBuildOptions>,
	decoder: CfgInstructionDecoder = decodeInstructionForCfg,
): CfgBuildResult => {
	const mergedOptions = mergeOptions(options);
	const anchorMatch = source.findMemoryRangeAt(anchorAddress);
	if (!anchorMatch) {
		return {
			status: "missing_memory",
			message: `Address ${fmtAddress(anchorAddress)} is not present in dump memory.`,
			anchorAddress,
			anchorNodeId: null,
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

	const knownBlockStarts = new Set<bigint>();
	const pendingStarts: bigint[] = [];
	const blockMap = new Map<string, CfgNode>();
	const syntheticMap = new Map<string, CfgNode>();
	const aliasMap = new Map<string, string>();
	const edgeMap = new Map<string, CfgEdge>();
	const instructionCounter = { value: 0 };
	let discoveryIndex = 0;
	let truncated = false;
	let anchorNodeId: string | null = blockIdForAddress(anchorAddress);

	const markTruncated = () => {
		truncated = true;
	};

	const ensureSyntheticNode = (
		kind: CfgNodeKind,
		key: string,
		title: string,
		label: string,
		address: bigint | null,
	) => {
		const id = syntheticNodeId(kind, key);
		const existing = syntheticMap.get(id);
		if (existing) {
			return existing;
		}

		const node = makeNode(
			kind,
			id,
			discoveryIndex++,
			address,
			address,
			[],
			title,
			label,
		);
		syntheticMap.set(id, node);
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
			markTruncated();
			return;
		}

		const id = `${from}->${to}:${kind}`;
		if (edgeMap.has(id)) {
			return;
		}

		edgeMap.set(id, { id, from, to, kind });
	};

	enqueueStart(anchorAddress);

	while (pendingStarts.length > 0) {
		if (blockMap.size >= mergedOptions.maxBlocks) {
			markTruncated();
			break;
		}
		if (instructionCounter.value >= mergedOptions.maxInstructions) {
			markTruncated();
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
			instructionCounter,
			mergedOptions,
			markTruncated,
		);
		const blockId = blockIdForAddress(startAddress);

		if (!block) {
			const errorNode = ensureSyntheticNode(
				"decode_error",
				`start:${fmtAddress(startAddress)}`,
				"decode error",
				`decode error\n${fmtAddress(startAddress)}`,
				startAddress,
			);
			aliasMap.set(blockId, errorNode.id);
			if (startAddress === anchorAddress) {
				anchorNodeId = errorNode.id;
			}
			continue;
		}

		block.discoveryIndex = discoveryIndex++;
		blockMap.set(block.id, block);

		for (const successor of successors) {
			if (
				successor.syntheticKind &&
				successor.syntheticKey &&
				successor.syntheticTitle &&
				successor.syntheticLabel
			) {
				const node = ensureSyntheticNode(
					successor.syntheticKind,
					successor.syntheticKey,
					successor.syntheticTitle,
					successor.syntheticLabel,
					successor.syntheticAddress,
				);
				addEdge(block.id, node.id, successor.kind);
				continue;
			}

			const targetAddress = successor.targetAddress;
			if (targetAddress === null) {
				continue;
			}

			if (!source.findMemoryRangeAt(targetAddress)) {
				const node = ensureSyntheticNode(
					"missing_memory",
					fmtAddress(targetAddress),
					"missing memory",
					`missing memory\n${fmtAddress(targetAddress)}`,
					targetAddress,
				);
				addEdge(block.id, node.id, successor.kind);
				continue;
			}

			const targetId = blockIdForAddress(targetAddress);
			addEdge(block.id, targetId, successor.kind);
			enqueueStart(targetAddress);
		}
	}

	const nodes = [...blockMap.values(), ...syntheticMap.values()].sort(
		(a, b) => a.discoveryIndex - b.discoveryIndex,
	);
	const nodeIds = new Set(nodes.map((node) => node.id));
	const resolvedEdges: CfgEdge[] = [];

	for (const edge of edgeMap.values()) {
		const targetId = aliasMap.get(edge.to) ?? edge.to;
		if (!nodeIds.has(targetId)) {
			continue;
		}

		const id = `${edge.from}->${targetId}:${edge.kind}`;
		if (resolvedEdges.some((candidate) => candidate.id === id)) {
			continue;
		}

		resolvedEdges.push({
			...edge,
			id,
			to: targetId,
		});
	}

	const status: CfgBuildStatus =
		blockMap.size === 0 &&
		anchorNodeId &&
		anchorNodeId.startsWith("synthetic:decode_error")
			? "decode_error"
			: truncated
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
		anchorNodeId,
		blocks: nodes,
		edges: resolvedEdges,
		stats: {
			blockCount: blockMap.size,
			edgeCount: resolvedEdges.length,
			instructionCount: instructionCounter.value,
			truncated,
		},
	};
};

const sanitizeLineCount = (value: number) =>
	Number.isFinite(value) && value > 0 ? value : 2;

export const estimateNodeDimensions = (node: CfgNode) => {
	const lines = node.label.split("\n");
	const maxLineLength = lines.reduce((maxLength, line) => {
		return Math.max(maxLength, line.length);
	}, 0);
	const height = Math.max(
		MIN_CARD_HEIGHT,
		CARD_PADDING_Y + sanitizeLineCount(node.lineCount) * ESTIMATED_LINE_HEIGHT,
	);
	const width = Math.max(
		MIN_CARD_WIDTH,
		CARD_PADDING_X + maxLineLength * ESTIMATED_CHAR_WIDTH,
	);
	return { width, height };
};
