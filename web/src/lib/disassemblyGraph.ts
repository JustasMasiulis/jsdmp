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
export type CfgNodeKind =
	| "block"
	| "unknown_exit"
	| "missing_memory"
	| "decode_error"
	| "truncated";
export type CfgEdgeKind = "branch" | "fallthrough" | "unknown";

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
	isBackedge: boolean;
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

export type PositionedCfgNode = CfgNode & {
	x: number;
	y: number;
	size: number;
	color: string;
	depth: number;
	width: number;
	height: number;
	compactLabel: string;
	fullLabel: string;
};

export type PositionedCfgEdge = CfgEdge & {
	color: string;
	size: number;
	label: string | null;
};

export type PositionedCfgGraph = {
	nodes: PositionedCfgNode[];
	edges: PositionedCfgEdge[];
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

const ESTIMATED_CHAR_WIDTH = 7.2;
const ESTIMATED_LINE_HEIGHT = 15;
const CARD_PADDING_X = 16;
const CARD_PADDING_Y = 12;
const MIN_CARD_WIDTH = 156;
const MIN_CARD_HEIGHT = 38;
const COLUMN_GAP = 72;
const ROW_GAP = 28;

const fmtAddress = (value: bigint) =>
	`0x${value.toString(16).toUpperCase().padStart(16, "0")}`;

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
		case "interrupt":
		case "syscall":
		case "system":
			return true;
		default:
			return false;
	}
};

const buildBlockLabel = (
	startAddress: bigint,
	instructions: CfgInstruction[],
) =>
	[
		fmtAddress(startAddress),
		...instructions.map(
			(instruction) =>
				`${fmtAddress(instruction.address)}  ${instruction.text}`,
		),
	].join("\n");

const makeSyntheticSuccessor = (
	kind: CfgNodeKind,
	key: string,
	title: string,
	label: string,
	address: bigint | null,
): PendingSuccessor => ({
	kind: "unknown",
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
			successors.push(
				makeSyntheticSuccessor(
					"truncated",
					"budget",
					"truncated",
					"truncated\ninstruction budget reached",
					null,
				),
			);
			break;
		}

		if (instructions.length > 0 && knownBlockStarts.has(cursor)) {
			successors.push({
				kind: "fallthrough",
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
			if (
				decoded.controlFlow.hasDirectTarget &&
				decoded.controlFlow.directTargetAddress !== null
			) {
				successors.push({
					kind: "branch",
					targetAddress: decoded.controlFlow.directTargetAddress,
					syntheticKind: null,
					syntheticKey: null,
					syntheticTitle: null,
					syntheticLabel: null,
					syntheticAddress: null,
				});
			} else if (!decoded.controlFlow.hasFallthrough) {
				successors.push(
					makeSyntheticSuccessor(
						"unknown_exit",
						`${fmtAddress(startAddress)}:${fmtAddress(decoded.address)}`,
						"indirect exit",
						`indirect exit\n${decoded.text}`,
						decoded.address,
					),
				);
			}

			if (decoded.controlFlow.hasFallthrough) {
				if (source.findMemoryRangeAt(nextAddress)) {
					successors.push({
						kind: "fallthrough",
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
			buildBlockLabel(startAddress, instructions),
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

		edgeMap.set(id, {
			id,
			from,
			to,
			kind,
			isBackedge: false,
		});
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

	if (truncated) {
		ensureSyntheticNode(
			"truncated",
			"global",
			"truncated",
			"truncated\ngraph limits reached",
			null,
		);
	}

	const nodes = [...blockMap.values(), ...syntheticMap.values()].sort(
		(a, b) => a.discoveryIndex - b.discoveryIndex,
	);
	const nodeIds = new Set(nodes.map((node) => node.id));
	const truncatedNodeId = syntheticMap.get(
		syntheticNodeId("truncated", "global"),
	)?.id;
	const resolvedEdges: CfgEdge[] = [];

	for (const edge of edgeMap.values()) {
		let targetId = aliasMap.get(edge.to) ?? edge.to;
		if (!nodeIds.has(targetId)) {
			if (truncated && truncatedNodeId) {
				targetId = truncatedNodeId;
			} else {
				continue;
			}
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

const colorForNodeKind = (kind: CfgNodeKind) => {
	switch (kind) {
		case "unknown_exit":
			return "#B45309";
		case "missing_memory":
			return "#C2410C";
		case "decode_error":
			return "#B42318";
		case "truncated":
			return "#475467";
		default:
			return "#1D4ED8";
	}
};

const colorForEdge = (kind: CfgEdgeKind, isBackedge: boolean) => {
	if (isBackedge) {
		return "#BE123C";
	}

	switch (kind) {
		case "fallthrough":
			return "#0F766E";
		case "unknown":
			return "#B45309";
		default:
			return "#2563EB";
	}
};

const maxFiniteDepth = (depthMap: Map<string, number>) => {
	let maxDepth = 0;
	for (const depth of depthMap.values()) {
		if (Number.isFinite(depth) && depth > maxDepth) {
			maxDepth = depth;
		}
	}
	return maxDepth;
};

const sanitizeLineCount = (value: number) =>
	Number.isFinite(value) && value > 0 ? value : 2;

const sanitizeCoordinate = (value: number, fallback: number) =>
	Number.isFinite(value) ? value : fallback;

const estimateNodeDimensions = (node: CfgNode) => {
	const lines = node.label.split("\n");
	const maxLineLength = lines.reduce((maxLength, line) => {
		return Math.max(maxLength, line.length);
	}, 0);
	const height = Math.max(
		MIN_CARD_HEIGHT,
		CARD_PADDING_Y * 2 +
			sanitizeLineCount(node.lineCount) * ESTIMATED_LINE_HEIGHT,
	);
	const width = Math.max(
		MIN_CARD_WIDTH,
		CARD_PADDING_X * 2 + maxLineLength * ESTIMATED_CHAR_WIDTH,
	);
	return {
		width,
		height,
		compactLabel: node.title,
		fullLabel: node.label,
	};
};

export const layoutControlFlowGraph = (
	result: CfgBuildResult,
): PositionedCfgGraph => {
	const nodesById = new Map(
		result.blocks.map((node) => [node.id, node] as const),
	);
	const adjacency = new Map<string, string[]>();
	for (const node of result.blocks) {
		adjacency.set(node.id, []);
	}
	for (const edge of result.edges) {
		const next = adjacency.get(edge.from);
		if (next) {
			next.push(edge.to);
		}
	}

	const depthMap = new Map<string, number>();
	const queue: string[] = [];
	if (result.anchorNodeId && nodesById.has(result.anchorNodeId)) {
		depthMap.set(result.anchorNodeId, 0);
		queue.push(result.anchorNodeId);
	}

	while (queue.length > 0) {
		const current = queue.shift();
		if (!current) {
			continue;
		}
		const currentDepth = depthMap.get(current) ?? 0;
		const safeCurrentDepth = Number.isFinite(currentDepth) ? currentDepth : 0;
		for (const neighbor of adjacency.get(current) ?? []) {
			if (depthMap.has(neighbor)) {
				continue;
			}
			depthMap.set(neighbor, safeCurrentDepth + 1);
			queue.push(neighbor);
		}
	}

	let fallbackDepth = maxFiniteDepth(depthMap) + 1;
	for (const node of result.blocks) {
		if (!depthMap.has(node.id)) {
			depthMap.set(node.id, fallbackDepth);
			fallbackDepth += 1;
		}
	}

	const columns = new Map<number, CfgNode[]>();
	for (const node of result.blocks) {
		const depthValue = depthMap.get(node.id);
		const depth = Number.isFinite(depthValue) ? (depthValue as number) : 0;
		const bucket = columns.get(depth);
		if (bucket) {
			bucket.push(node);
		} else {
			columns.set(depth, [node]);
		}
	}

	const positionedNodes: PositionedCfgNode[] = [];
	const sortedColumns = [...columns.entries()].sort((a, b) => a[0] - b[0]);
	const columnMetrics = sortedColumns.map(([depth, columnNodes]) => {
		const nodeDimensions = new Map<
			string,
			ReturnType<typeof estimateNodeDimensions>
		>();
		let maxWidth = MIN_CARD_WIDTH;
		for (const node of columnNodes) {
			const dimensions = estimateNodeDimensions(node);
			nodeDimensions.set(node.id, dimensions);
			if (dimensions.width > maxWidth) {
				maxWidth = dimensions.width;
			}
		}
		return {
			depth,
			columnNodes,
			maxWidth,
			nodeDimensions,
		};
	});

	const totalWidth = columnMetrics.reduce((total, column, index) => {
		return total + column.maxWidth + (index === 0 ? 0 : COLUMN_GAP);
	}, 0);

	let cursorX = sanitizeCoordinate(-totalWidth / 2, 0);
	let fallbackIndex = 0;
	for (const column of columnMetrics) {
		const { depth, columnNodes, maxWidth, nodeDimensions } = column;
		columnNodes.sort((a, b) => {
			const aAddress = a.startAddress ?? BigInt(Number.MAX_SAFE_INTEGER);
			const bAddress = b.startAddress ?? BigInt(Number.MAX_SAFE_INTEGER);
			if (aAddress < bAddress) {
				return -1;
			}
			if (aAddress > bAddress) {
				return 1;
			}
			return a.discoveryIndex - b.discoveryIndex;
		});

		const totalHeight = columnNodes.reduce((total, node) => {
			const dimensions =
				nodeDimensions.get(node.id) ?? estimateNodeDimensions(node);
			return total + dimensions.height;
		}, 0);
		const totalHeightWithGaps =
			totalHeight + Math.max(0, columnNodes.length - 1) * ROW_GAP;
		let cursorY = sanitizeCoordinate(-totalHeightWithGaps / 2, 0);
		const safeDepth = Number.isFinite(depth) ? depth : fallbackIndex;
		const columnCenterX = sanitizeCoordinate(
			cursorX + maxWidth / 2,
			fallbackIndex * (MIN_CARD_WIDTH + COLUMN_GAP),
		);
		for (const node of columnNodes) {
			const dimensions =
				nodeDimensions.get(node.id) ?? estimateNodeDimensions(node);
			const fallbackY = fallbackIndex * (MIN_CARD_HEIGHT + ROW_GAP);
			positionedNodes.push({
				...node,
				depth: safeDepth,
				x: columnCenterX,
				y: sanitizeCoordinate(cursorY + dimensions.height / 2, fallbackY),
				size: node.kind === "block" ? 12 : 10,
				color: colorForNodeKind(node.kind),
				width: dimensions.width,
				height: dimensions.height,
				compactLabel: dimensions.compactLabel,
				fullLabel: dimensions.fullLabel,
			});
			cursorY = sanitizeCoordinate(
				cursorY + dimensions.height + ROW_GAP,
				fallbackY + dimensions.height + ROW_GAP,
			);
			fallbackIndex += 1;
		}
		cursorX = sanitizeCoordinate(
			cursorX + maxWidth + COLUMN_GAP,
			columnCenterX + maxWidth / 2 + COLUMN_GAP,
		);
	}

	const nodeDepths = new Map(
		positionedNodes.map((node) => [node.id, node.depth] as const),
	);
	const positionedEdges: PositionedCfgEdge[] = result.edges.map((edge) => {
		const fromDepth = nodeDepths.get(edge.from) ?? 0;
		const toDepth = nodeDepths.get(edge.to) ?? fromDepth;
		const safeFromDepth = Number.isFinite(fromDepth) ? fromDepth : 0;
		const safeToDepth = Number.isFinite(toDepth) ? toDepth : safeFromDepth;
		const isBackedge = safeToDepth <= safeFromDepth && edge.kind !== "unknown";
		return {
			...edge,
			isBackedge,
			color: colorForEdge(edge.kind, isBackedge),
			size: edge.kind === "fallthrough" ? 1.5 : 2,
			label:
				edge.kind === "fallthrough"
					? null
					: edge.kind === "branch"
						? "branch"
						: "unknown",
		};
	});

	return {
		nodes: positionedNodes,
		edges: positionedEdges,
	};
};
