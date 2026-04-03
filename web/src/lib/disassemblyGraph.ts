import type { DebugInterface, DebugModule } from "./debug_interface";
import {
	type DecodedControlFlow,
	decodeInstruction,
	type InstrTextSegment,
	joinSegmentText,
	MAX_INSTRUCTION_LENGTH,
} from "./disassembly";
import { fmtHex16 } from "./formatting";
import { ZydisMnemonic } from "./mnemonic";
import { resolveSymbol, symbolicateSegments } from "./symbolication";

export type CfgEdgeKind = "true" | "false" | "unconditional";

export type CfgInstruction = {
	address: bigint;
	byteLength: number;
	prefix: string;
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

const mnemonicColumnWidth = (
	instruction: Pick<CfgInstruction, "prefix" | "mnemonic">,
) => {
	const prefixLen = instruction.prefix ? instruction.prefix.length + 1 : 0;
	return prefixLen + instruction.mnemonic.length;
};

export const buildCfgInstructionLine = (
	instruction: Pick<
		CfgInstruction,
		"address" | "prefix" | "mnemonic" | "operandSegments"
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
		"address" | "prefix" | "mnemonic" | "operandSegments"
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

const decodeBlock = async (
	dbg: DebugInterface,
	blockAddr: bigint,
	knownAddrs: Set<bigint>,
	addPendingBlock: (addr: bigint) => void,
	addEdge: (to: bigint, kind: CfgEdgeKind) => void,
): Promise<BuiltBlock> => {
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

		if (
			decoded.mnemonicId === ZydisMnemonic.ZYDIS_MNEMONIC_INT3 ||
			decoded.mnemonicId === ZydisMnemonic.ZYDIS_MNEMONIC_UD2
		) {
			break;
		}

		ip = nextIp;
	}

	return { address: blockAddr, instructions, error };
};

const annotateBlockSymbols = async (
	instructions: CfgInstruction[],
	modules: readonly DebugModule[],
): Promise<void> => {
	await Promise.all(
		instructions.map((instr) => {
			const addresses = [
				...(instr.controlFlow.directTargetAddress !== null
					? [instr.controlFlow.directTargetAddress]
					: []),
				...instr.ripRelativeTargets,
			];
			if (addresses.length === 0) return;
			return symbolicateSegments(instr.operandSegments, addresses, modules);
		}),
	);
};

const makeNode = async (
	block: BuiltBlock,
	modules: readonly DebugModule[],
): Promise<CfgNode> => {
	await annotateBlockSymbols(block.instructions, modules);
	const lines = buildCfgInstructionLines(block.instructions);
	if (block.error) {
		lines.push(...buildCfgTextLinesFromLabel(block.error));
	}
	const title = await resolveSymbol(block.address, modules);
	return {
		id: blockIdForAddress(block.address),
		title,
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

export const buildCfg2 = async (
	dbg: DebugInterface,
	entryAddress: bigint,
): Promise<CfgBuildResult> => {
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
		);

		commitBlock(built);
	}

	// Deduplicate edges and build final output
	const seenEdges = new Set<string>();
	const finalEdges: CfgEdge[] = [];
	for (const [from, to, kind] of edgeTuples) {
		const key = `${from}->${to}`;
		if (!seenEdges.has(key)) {
			seenEdges.add(key);
			finalEdges.push({
				id: key,
				from: blockIdForAddress(from),
				to: blockIdForAddress(to),
				kind,
			});
		}
	}

	const modules = dbg.modules.state;
	let totalInstructions = 0;
	const nodePromises: Promise<CfgNode>[] = [];
	for (const built of builtBlocks.values()) {
		totalInstructions += built.instructions.length;
		nodePromises.push(makeNode(built, modules));
	}
	const allBlocks = await Promise.all(nodePromises);

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

export const estimateNodeDimensions = (node: CfgNode) => {
	const maxLineLength = node.lines.reduce(
		(maxLength, line) => Math.max(maxLength, line.text.length),
		0,
	);
	const height = CARD_PADDING_Y + node.lines.length * ESTIMATED_LINE_HEIGHT;
	const width = CARD_PADDING_X + maxLineLength * ESTIMATED_CHAR_WIDTH;
	return { width, height };
};
