import type { DebugInterface } from "./debug_interface";
import {
	type DecodedControlFlow,
	decodeInstruction,
	type InstrTextSegment,
	joinSegmentText,
	maxInstructionLength,
} from "./disassembly";
import { fmtHex, fmtHex16 } from "./formatting";
import { resolveSymbol, symbolicateSegmentGroups } from "./symbolication";

export type CfgEdgeKind = "true" | "false" | "unconditional";

export type CfgInstruction = {
	address: bigint;
	byteLength: number;
	bytesHex: string;
	mnemonic: string;
	operandSegments: InstrTextSegment[];
	controlFlow: DecodedControlFlow;
	ripRelativeTargets: bigint[];
};

export type CfgTextSegment = {
	text: string;
	clickable: boolean;
	term: string | null;
	syntaxKind: CfgTextSyntaxKind;
	targetAddress?: bigint;
};

export type CfgTextSyntaxKind = "plain" | "mnemonic" | "number";

export type CfgTextLine = {
	text: string;
	segments: CfgTextSegment[];
};

export const getCfgLineAddress = (line: CfgTextLine): bigint | null => {
	const text = line.segments[0]?.text;
	if (!text || text.length < 16) return null;
	try {
		return BigInt(`0x${text}`);
	} catch {
		return null;
	}
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

export type ReachableCfgBlock = {
	id: string;
	address: bigint;
	title: string;
	instructions: CfgInstruction[];
	error: string | null;
};

export type ReachableCfgEdge = {
	id: string;
	fromAddress: bigint;
	toAddress: bigint;
	kind: CfgEdgeKind;
};

export type ReachableCfgBuildResult = {
	anchorAddress: bigint;
	blocks: ReachableCfgBlock[];
	edges: ReachableCfgEdge[];
	stats: CfgBuildStats;
};

export type LinearizedCfgBlock = {
	block: ReachableCfgBlock;
	incomingEdges: ReachableCfgEdge[];
	outgoingEdges: ReachableCfgEdge[];
	overlapSourceAddresses: bigint[];
};

export const ESTIMATED_CHAR_WIDTH = 7;
export const ESTIMATED_LINE_HEIGHT = 15;
export const CARD_PADDING_X = 16 + 2;
export const CARD_PADDING_Y = 12 + 2;

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

const INSTR_TO_CFG_SYNTAX: Record<
	InstrTextSegment["syntaxKind"],
	CfgTextSyntaxKind
> = {
	plain: "plain",
	mnemonic: "mnemonic",
	number: "number",
	register: "plain",
	keyword: "plain",
};

const instrSegmentsToCfg = (segments: InstrTextSegment[]): CfgTextSegment[] =>
	segments.map((s) => {
		const isClickable = s.syntaxKind !== "plain";
		const cfgSeg = makeTextSegment(
			s.text,
			isClickable,
			isClickable ? s.text : null,
			INSTR_TO_CFG_SYNTAX[s.syntaxKind],
		);
		if (s.targetAddress !== undefined) cfgSeg.targetAddress = s.targetAddress;
		return cfgSeg;
	});

const blockIdForAddress = (address: bigint) => `block:${address.toString(16)}`;

const mnemonicColumnWidth = (instruction: Pick<CfgInstruction, "mnemonic">) =>
	instruction.mnemonic.length;

export const buildCfgInstructionLine = (
	instruction: Pick<CfgInstruction, "address" | "mnemonic" | "operandSegments">,
	columnWidth = mnemonicColumnWidth(instruction),
): CfgTextLine => {
	const segments: CfgTextSegment[] = [
		makeTextSegment(fmtHex16(instruction.address), true, null, "plain"),
		makeTextSegment("  "),
	];

	segments.push(makeTextSegment(instruction.mnemonic, true, null, "mnemonic"));

	if (instruction.operandSegments.length > 0) {
		segments.push(
			makeTextSegment(
				" ".repeat(
					Math.max(1, columnWidth - mnemonicColumnWidth(instruction) + 1),
				),
			),
		);
		segments.push(...instrSegmentsToCfg(instruction.operandSegments));
	}

	return {
		text: joinSegmentText(segments),
		segments,
	};
};

export const buildCfgTextLinesFromLabel = (label: string): CfgTextLine[] =>
	label.split("\n").map((line) => ({
		text: line,
		segments: [makeTextSegment(line)],
	}));

export const buildCfgInstructionLines = (
	instructions: readonly Pick<
		CfgInstruction,
		"address" | "mnemonic" | "operandSegments"
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

type BuiltBlock = {
	address: bigint;
	instructions: CfgInstruction[];
	error: string | null;
};

const compareBigints = (a: bigint, b: bigint) => {
	if (a === b) return 0;
	return a < b ? -1 : 1;
};

const cfgEdgeTraversalPriority = (kind: CfgEdgeKind) => {
	switch (kind) {
		case "false":
			return 0;
		case "unconditional":
			return 1;
		case "true":
			return 2;
	}
};

const sortCfgEdgesForLinearization = (
	left: ReachableCfgEdge,
	right: ReachableCfgEdge,
) => {
	const byKind =
		cfgEdgeTraversalPriority(left.kind) - cfgEdgeTraversalPriority(right.kind);
	if (byKind !== 0) {
		return byKind;
	}
	return compareBigints(left.toAddress, right.toAddress);
};

const decodeBlock = async (
	dbg: DebugInterface,
	blockAddr: bigint,
	knownAddrs: Set<bigint>,
	addPendingBlock: (addr: bigint) => void,
	addEdge: (to: bigint, kind: CfgEdgeKind) => void,
	arch: number,
): Promise<BuiltBlock> => {
	const maxLen = maxInstructionLength(arch);
	const instructions: CfgInstruction[] = [];
	let ip = blockAddr;

	let error: string | null = null;
	loop: while (true) {
		if (instructions.length > 0 && knownAddrs.has(ip)) {
			addEdge(ip, "unconditional");
			break;
		}

		let bytes: Uint8Array;
		try {
			bytes = await dbg.read(ip, maxLen, 1);
		} catch {
			error = "missing memory";
			break;
		}

		const decoded = decodeInstruction(bytes, ip, arch);
		if (!decoded) {
			error = "decode error";
			break;
		}

		instructions.push({
			address: ip,
			byteLength: decoded.length,
			bytesHex: [...decoded.bytes].map((b) => fmtHex(b, 2)).join(" "),
			mnemonic: decoded.mnemonic,
			operandSegments: decoded.operandSegments,
			controlFlow: decoded.controlFlow,
			ripRelativeTargets: decoded.ripRelativeTargets,
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

		if (decoded.controlFlow.kind === "interrupt") {
			break;
		}

		ip = nextIp;
	}

	return { address: blockAddr, instructions, error };
};

const collectBlockSymbolicationGroups = (
	instructions: CfgInstruction[],
): Array<{ segments: InstrTextSegment[]; addresses: bigint[] }> =>
	instructions.flatMap((instr) => {
		const addresses = [
			...(instr.controlFlow.directTargetAddress !== null
				? [instr.controlFlow.directTargetAddress]
				: []),
			...instr.ripRelativeTargets,
		];
		return addresses.length > 0
			? [{ segments: instr.operandSegments, addresses }]
			: [];
	});

const makeNode = (block: ReachableCfgBlock): CfgNode => {
	const lines = buildCfgInstructionLines(block.instructions);
	if (block.error) {
		lines.push(...buildCfgTextLinesFromLabel(block.error));
	}
	return {
		id: block.id,
		title: block.title,
		instructionCount: block.instructions.length,
		lines,
	};
};

const splitBlock = (
	block: BuiltBlock,
	splitAddr: bigint,
): [BuiltBlock, BuiltBlock] | null => {
	const splitIndex = block.instructions.findIndex(
		(instr) => instr.address === splitAddr,
	);
	if (splitIndex <= 0) {
		return null;
	}

	return [
		{
			address: block.address,
			instructions: block.instructions.slice(0, splitIndex),
			error: null,
		},
		{
			address: splitAddr,
			instructions: block.instructions.slice(splitIndex),
			error: block.error,
		},
	];
};

export const buildReachableCfg = async (
	dbg: DebugInterface,
	entryAddress: bigint,
): Promise<ReachableCfgBuildResult> => {
	performance.mark("buildReachableCfg-start");
	const arch = dbg.arch;
	const builtBlocks = new Map<bigint, BuiltBlock>();
	const knownAddrs = new Set<bigint>([entryAddress]);
	const pendingBlocks: bigint[] = [entryAddress];
	const instrToBlock = new Map<bigint, bigint>();

	// Edges stored as [fromAddr, toAddr, kind] — no string keys during traversal.
	// Deduped by a Set of `${from},${to}` at the end.
	const edgeTuples: [bigint, bigint, CfgEdgeKind][] = [];
	// Index: blockAddr → indices into edgeTuples where that block is the source.
	// Used by trySplit to rewire edges without scanning all edges.
	const edgesBySource = new Map<bigint, number[]>();

	const addEdgeTuple = (from: bigint, to: bigint, kind: CfgEdgeKind) => {
		const idx = edgeTuples.length;
		edgeTuples.push([from, to, kind]);
		let list = edgesBySource.get(from);
		if (!list) {
			list = [];
			edgesBySource.set(from, list);
		}
		list.push(idx);
	};

	const commitBlock = (built: BuiltBlock) => {
		builtBlocks.set(built.address, built);
		knownAddrs.add(built.address);
		for (const instr of built.instructions) {
			instrToBlock.set(instr.address, built.address);
		}
	};

	const trySplit = (targetAddr: bigint): boolean => {
		const ownerAddr = instrToBlock.get(targetAddr);
		if (ownerAddr === undefined || ownerAddr === targetAddr) {
			return false;
		}

		const existing = builtBlocks.get(ownerAddr);
		if (!existing) {
			return false;
		}

		const halves = splitBlock(existing, targetAddr);
		if (!halves) {
			return false;
		}

		const [head, tail] = halves;
		commitBlock(head);
		commitBlock(tail);

		// Rewire: edges from ownerAddr now come from targetAddr (the tail)
		const ownerEdges = edgesBySource.get(ownerAddr);
		if (ownerEdges) {
			const movedIndices: number[] = [];
			for (const idx of ownerEdges) {
				edgeTuples[idx][0] = targetAddr;
				movedIndices.push(idx);
			}
			edgesBySource.delete(ownerAddr);
			const tailList = edgesBySource.get(targetAddr);
			if (tailList) {
				tailList.push(...movedIndices);
			} else {
				edgesBySource.set(targetAddr, movedIndices);
			}
		}

		// Add fallthrough edge from head to tail
		addEdgeTuple(ownerAddr, targetAddr, "unconditional");

		return true;
	};

	let currentAddr = 0n;

	const addPendingBlock = (newBlockAddr: bigint) => {
		if (currentAddr === newBlockAddr) {
			return;
		}

		if (trySplit(newBlockAddr)) {
			return;
		}

		if (knownAddrs.has(newBlockAddr)) {
			return;
		}

		knownAddrs.add(newBlockAddr);
		pendingBlocks.push(newBlockAddr);
	};

	const addEdge = (to: bigint, kind: CfgEdgeKind) => {
		addEdgeTuple(currentAddr, to, kind);
	};

	while (pendingBlocks.length > 0) {
		const addr = pendingBlocks.pop();

		if (builtBlocks.has(addr)) {
			continue;
		}

		if (trySplit(addr)) {
			continue;
		}

		currentAddr = addr;

		const built = await decodeBlock(
			dbg,
			addr,
			knownAddrs,
			addPendingBlock,
			addEdge,
			arch,
		);

		commitBlock(built);
	}

	// Deduplicate edges and build final output
	const seenEdges = new Set<string>();
	const finalEdges: ReachableCfgEdge[] = [];
	for (const [from, to, kind] of edgeTuples) {
		const key = `${from}->${to}`;
		if (!seenEdges.has(key)) {
			seenEdges.add(key);
			finalEdges.push({
				id: key,
				fromAddress: from,
				toAddress: to,
				kind,
			});
		}
	}

	performance.mark("buildReachableCfg-end");
	performance.measure(
		"buildReachableCfg",
		"buildReachableCfg-start",
		"buildReachableCfg-end",
	);

	const modules = dbg.modules.state;
	const builtBlockList = [...builtBlocks.values()];
	await symbolicateSegmentGroups(
		builtBlockList.flatMap((built) =>
			collectBlockSymbolicationGroups(built.instructions),
		),
		modules,
	);

	let totalInstructions = 0;
	const blockPromises: Promise<ReachableCfgBlock>[] = [];
	for (const built of builtBlockList) {
		totalInstructions += built.instructions.length;
		blockPromises.push(
			(async () => {
				return {
					id: blockIdForAddress(built.address),
					address: built.address,
					title: await resolveSymbol(built.address, modules),
					instructions: built.instructions,
					error: built.error,
				};
			})(),
		);
	}
	const allBlocks = await Promise.all(blockPromises);

	performance.mark("buildReachableCfg-blocksReady");
	performance.measure(
		"buildReachableCfg-annotation",
		"buildReachableCfg-end",
		"buildReachableCfg-blocksReady",
	);

	return {
		anchorAddress: entryAddress,
		blocks: allBlocks,
		edges: finalEdges,
		stats: {
			blockCount: allBlocks.length,
			edgeCount: finalEdges.length,
			instructionCount: totalInstructions,
			truncated: false,
		},
	};
};

export const linearizeReachableCfg = (
	result: ReachableCfgBuildResult,
): LinearizedCfgBlock[] => {
	const blocksByAddress = new Map<bigint, ReachableCfgBlock>();
	const incomingEdges = new Map<bigint, ReachableCfgEdge[]>();
	const outgoingEdges = new Map<bigint, ReachableCfgEdge[]>();

	for (const block of result.blocks) {
		blocksByAddress.set(block.address, block);
		incomingEdges.set(block.address, []);
		outgoingEdges.set(block.address, []);
	}

	for (const edge of result.edges) {
		outgoingEdges.get(edge.fromAddress)?.push(edge);
		incomingEdges.get(edge.toAddress)?.push(edge);
	}

	for (const edges of incomingEdges.values()) {
		edges.sort(sortCfgEdgesForLinearization);
	}
	for (const edges of outgoingEdges.values()) {
		edges.sort(sortCfgEdgesForLinearization);
	}

	const sortedBlockAddresses = [...blocksByAddress.keys()].sort(compareBigints);

	// Iterative pre-order DFS. Children pushed in reverse so the first outgoing
	// edge is popped (and thus visited) first, matching the prior recursive order.
	const orderedAddresses: bigint[] = [];
	const visited = new Set<bigint>();
	const stack: bigint[] = [];

	const visitFrom = (root: bigint) => {
		if (visited.has(root) || !blocksByAddress.has(root)) return;
		stack.push(root);
		while (stack.length > 0) {
			const address = stack.pop() as bigint;
			if (visited.has(address)) continue;
			visited.add(address);
			orderedAddresses.push(address);
			const outgoing = outgoingEdges.get(address);
			if (!outgoing) continue;
			for (let i = outgoing.length - 1; i >= 0; i--) {
				const next = outgoing[i].toAddress;
				if (!visited.has(next) && blocksByAddress.has(next)) {
					stack.push(next);
				}
			}
		}
	};

	visitFrom(result.anchorAddress);
	for (const address of sortedBlockAddresses) {
		visitFrom(address);
	}

	// Overlap detection: for each instruction, find block-start addresses
	// strictly inside (instruction.start, instruction.end) via binary search
	// over sortedBlockAddresses. The inner scan is bounded by max instruction
	// length (15 bytes on x86, 4 on ARM64), so this is O(M·log N) overall.
	const overlapSourcesByAddress = new Map<bigint, Set<bigint>>();
	for (const address of sortedBlockAddresses) {
		overlapSourcesByAddress.set(address, new Set());
	}

	const upperBoundAddress = (value: bigint): number => {
		let lo = 0;
		let hi = sortedBlockAddresses.length;
		while (lo < hi) {
			const mid = (lo + hi) >>> 1;
			if (sortedBlockAddresses[mid] <= value) {
				lo = mid + 1;
			} else {
				hi = mid;
			}
		}
		return lo;
	};

	for (const owner of result.blocks) {
		for (const instruction of owner.instructions) {
			const startAddress = instruction.address;
			const endAddress = startAddress + BigInt(instruction.byteLength);
			let i = upperBoundAddress(startAddress);
			while (
				i < sortedBlockAddresses.length &&
				sortedBlockAddresses[i] < endAddress
			) {
				const targetAddress = sortedBlockAddresses[i];
				if (targetAddress !== owner.address) {
					overlapSourcesByAddress.get(targetAddress)?.add(owner.address);
				}
				i++;
			}
		}
	}

	return orderedAddresses.map((address) => {
		const block = blocksByAddress.get(address);
		if (!block) {
			throw new Error(`Missing block for ${fmtHex16(address)}`);
		}
		const sources = overlapSourcesByAddress.get(address);
		return {
			block,
			incomingEdges: incomingEdges.get(address) ?? [],
			outgoingEdges: outgoingEdges.get(address) ?? [],
			overlapSourceAddresses: sources ? [...sources].sort(compareBigints) : [],
		};
	});
};

export const buildCfg2 = async (
	dbg: DebugInterface,
	entryAddress: bigint,
): Promise<CfgBuildResult> => {
	const reachableCfg = await buildReachableCfg(dbg, entryAddress);

	return {
		anchorAddress: reachableCfg.anchorAddress,
		blocks: reachableCfg.blocks.map((block) => makeNode(block)),
		edges: reachableCfg.edges.map((edge) => ({
			id: edge.id,
			from: blockIdForAddress(edge.fromAddress),
			to: blockIdForAddress(edge.toAddress),
			kind: edge.kind,
		})),
		stats: reachableCfg.stats,
	};
};

export const estimateNodeDimensions = (node: CfgNode) => {
	const maxLineLength = node.lines.reduce(
		(maxLength, line) => Math.max(maxLength, line.text.length),
		0,
	);
	const height = CARD_PADDING_Y + node.lines.length * ESTIMATED_LINE_HEIGHT;
	const width = CARD_PADDING_X + maxLineLength * ESTIMATED_CHAR_WIDTH;
	return { width, height };
};
