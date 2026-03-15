import { disassembleInstruction, MAX_INSTRUCTION_LENGTH } from "./disassembly";
import type {
	MiniDump,
	MinidumpAssociatedThread,
	MinidumpLocationDescriptor,
	MinidumpMemoryRangeMatch,
} from "./minidump";
import { maxU64 } from "./utils";

const CONTEXT_AMD64 = 0x00100000;
const DISASSEMBLY_LOOKBACK_BYTES = 64;
const DISASSEMBLY_PAGE_BYTES = 0x1000;

export type DecodedThreadContextX64 = {
	contextFlags: number;
	rflags: number;
	rax: bigint;
	rbx: bigint;
	rcx: bigint;
	rdx: bigint;
	rsi: bigint;
	rdi: bigint;
	rbp: bigint;
	rsp: bigint;
	r8: bigint;
	r9: bigint;
	r10: bigint;
	r11: bigint;
	r12: bigint;
	r13: bigint;
	r14: bigint;
	r15: bigint;
	rip: bigint;
};

export type DebugDisassemblyContextStatus =
	| "ok"
	| "unsupported_arch"
	| "missing_context";

export type DisassemblyStatus =
	| DebugDisassemblyContextStatus
	| "missing_memory"
	| "decode_error";

export type DisassemblyLine = {
	address: bigint;
	byteLength: number;
	bytesHex: string;
	mnemonic: string;
	operands: string;
	isCurrent: boolean;
};

export type DebugDisassemblyContext = {
	status: DebugDisassemblyContextStatus;
	message: string;
	threadId: number | null;
	instructionPointer: bigint | null;
	exceptionAddress: bigint | null;
	exceptionCode: number | null;
	registers: DecodedThreadContextX64 | null;
};

export type DebugDisassemblyListing = {
	status: DisassemblyStatus;
	message: string;
	anchorAddress: bigint | null;
	anchorLineIndex: number;
	hasMorePrevious: boolean;
	hasMoreNext: boolean;
	lines: DisassemblyLine[];
};

export type PreviousDisassemblyLoadResult = {
	lines: DisassemblyLine[];
	hasMoreBefore: boolean;
};

export type NextDisassemblyLoadResult = {
	lines: DisassemblyLine[];
	hasMoreAfter: boolean;
};

export type DisassemblyMemorySource = {
	readMemoryAt: (address: bigint, size: number) => Uint8Array | null;
	findMemoryRangeAt: (
		address: bigint,
		hintRangeIndex?: number,
	) => MinidumpMemoryRangeMatch | null;
};

type DecodedInstruction = {
	address: bigint;
	length: number;
	bytesHex: string;
	mnemonic: string;
	operands: string;
};

type DecodedLineResult = {
	line: DisassemblyLine;
	nextAddress: bigint;
};

const fmtAddress = (value: bigint) =>
	`0x${value.toString(16).toUpperCase().padStart(16, "0")}`;

const formatBytesHex = (bytes: Uint8Array) =>
	[...bytes]
		.map((value) => value.toString(16).toUpperCase().padStart(2, "0"))
		.join(" ");

const decodeX64Context = (
	contextBytes: Uint8Array,
): DecodedThreadContextX64 | null => {
	if (contextBytes.byteLength < 0x100) {
		return null;
	}

	const view = new DataView(
		contextBytes.buffer,
		contextBytes.byteOffset,
		contextBytes.byteLength,
	);
	const contextFlags = view.getUint32(0x30, true);
	if ((contextFlags & CONTEXT_AMD64) !== CONTEXT_AMD64) {
		return null;
	}

	const readU64 = (offset: number) => view.getBigUint64(offset, true);

	return {
		contextFlags,
		rflags: view.getUint32(0x44, true),
		rax: readU64(0x78),
		rbx: readU64(0x90),
		rcx: readU64(0x80),
		rdx: readU64(0x88),
		rsi: readU64(0xa8),
		rdi: readU64(0xb0),
		rbp: readU64(0xa0),
		rsp: readU64(0x98),
		r8: readU64(0xb8),
		r9: readU64(0xc0),
		r10: readU64(0xc8),
		r11: readU64(0xd0),
		r12: readU64(0xd8),
		r13: readU64(0xe0),
		r14: readU64(0xe8),
		r15: readU64(0xf0),
		rip: readU64(0xf8),
	};
};

const decodeContextFromLocation = (
	dump: MiniDump,
	location: MinidumpLocationDescriptor | null | undefined,
): DecodedThreadContextX64 | null => {
	if (!location) {
		return null;
	}

	const bytes = dump.readLocationBytes(location);
	if (!bytes) {
		return null;
	}

	return decodeX64Context(bytes);
};

const resolveContext = (
	dump: MiniDump,
): {
	threadId: number | null;
	registers: DecodedThreadContextX64 | null;
} => {
	const exceptionThreadId = dump.exceptionStream?.threadId ?? null;
	const exceptionContext = decodeContextFromLocation(
		dump,
		dump.exceptionStream?.threadContext,
	);
	if (exceptionContext) {
		return { threadId: exceptionThreadId, registers: exceptionContext };
	}

	const tryThread = (thread: MinidumpAssociatedThread) => {
		const decoded = decodeContextFromLocation(
			dump,
			thread.thread?.threadContext,
		);
		if (!decoded) {
			return null;
		}
		return {
			threadId: thread.threadId,
			registers: decoded,
		};
	};

	if (exceptionThreadId !== null) {
		const exceptionThread = (dump.associatedThreads ?? []).find(
			(thread) => thread.threadId === exceptionThreadId,
		);
		if (exceptionThread) {
			const resolved = tryThread(exceptionThread);
			if (resolved) {
				return resolved;
			}
		}
	}

	for (const thread of dump.associatedThreads ?? []) {
		const resolved = tryThread(thread);
		if (resolved) {
			return resolved;
		}
	}

	return {
		threadId: exceptionThreadId,
		registers: null,
	};
};

const decodeInstructionAt = (
	source: DisassemblyMemorySource,
	address: bigint,
	maxBytes = MAX_INSTRUCTION_LENGTH,
): DecodedInstruction | null => {
	const boundedMaxBytes = Math.max(
		1,
		Math.min(MAX_INSTRUCTION_LENGTH, Math.floor(maxBytes)),
	);
	const bytes = source.readMemoryAt(address, boundedMaxBytes);
	if (!bytes || bytes.byteLength === 0) {
		return null;
	}

	const decoded = disassembleInstruction(bytes, address);
	if (!decoded) {
		return null;
	}

	return {
		address,
		length: decoded.length,
		bytesHex: formatBytesHex(decoded.bytes),
		mnemonic: decoded.mnemonic,
		operands: decoded.operands,
	};
};

const formatDbOperand = (value: number) =>
	`0x${value.toString(16).toUpperCase().padStart(2, "0")}`;

const baseContext = (
	dump: MiniDump,
	threadId: number | null,
	registers: DecodedThreadContextX64 | null,
	instructionPointer: bigint | null,
): DebugDisassemblyContext => ({
	status: "ok",
	message: "",
	threadId,
	registers,
	instructionPointer,
	exceptionAddress:
		dump.exceptionStream?.exceptionRecord.exceptionAddress ?? null,
	exceptionCode: dump.exceptionStream?.exceptionRecord.exceptionCode ?? null,
});

const toListing = (
	status: DisassemblyStatus,
	message: string,
	anchorAddress: bigint | null,
	lines: DisassemblyLine[] = [],
	anchorLineIndex = -1,
	hasMorePrevious = false,
	hasMoreNext = false,
): DebugDisassemblyListing => ({
	status,
	message,
	anchorAddress,
	anchorLineIndex,
	hasMorePrevious,
	hasMoreNext,
	lines,
});

const buildFallbackLine = (
	source: DisassemblyMemorySource,
	address: bigint,
	isCurrent: boolean,
): DecodedLineResult | null => {
	const fallbackByte = source.readMemoryAt(address, 1);
	if (!fallbackByte || fallbackByte.byteLength === 0) {
		return null;
	}

	return {
		line: {
			address,
			byteLength: 1,
			bytesHex: formatBytesHex(fallbackByte),
			mnemonic: "db",
			operands: formatDbOperand(fallbackByte[0]),
			isCurrent,
		},
		nextAddress: address + 1n,
	};
};

const decodeOrFallbackLine = (
	source: DisassemblyMemorySource,
	address: bigint,
	maxBytes: number,
	isCurrent: boolean,
): DecodedLineResult | null => {
	const decoded = decodeInstructionAt(source, address, maxBytes);
	if (decoded) {
		return {
			line: {
				address: decoded.address,
				byteLength: decoded.length,
				bytesHex: decoded.bytesHex,
				mnemonic: decoded.mnemonic,
				operands: decoded.operands,
				isCurrent,
			},
			nextAddress: decoded.address + BigInt(decoded.length),
		};
	}

	return buildFallbackLine(source, address, isCurrent);
};

const buildPreviousGuessLines = (
	source: DisassemblyMemorySource,
	anchorAddress: bigint,
	rangeStart: bigint,
): DisassemblyLine[] => {
	if (anchorAddress <= rangeStart) {
		return [];
	}

	const lookbackStart = maxU64(
		rangeStart,
		anchorAddress - BigInt(DISASSEMBLY_LOOKBACK_BYTES),
	);
	const memo = new Map<bigint, DecodedInstruction[]>();

	const findBestChainEndingAt = (endAddress: bigint): DecodedInstruction[] => {
		const cached = memo.get(endAddress);
		if (cached) {
			return cached;
		}

		let bestChain: DecodedInstruction[] = [];
		const candidateStart = maxU64(
			lookbackStart,
			endAddress - BigInt(MAX_INSTRUCTION_LENGTH),
		);

		for (let start = candidateStart; start < endAddress; start += 1n) {
			const instructionLength = Number(endAddress - start);
			const decoded = decodeInstructionAt(source, start, instructionLength);
			if (!decoded || decoded.length !== instructionLength) {
				continue;
			}

			const prefix = start > lookbackStart ? findBestChainEndingAt(start) : [];
			const chain = [...prefix, decoded];
			const bestStart = bestChain[0]?.address ?? null;

			if (
				chain.length > bestChain.length ||
				(chain.length === bestChain.length &&
					(bestStart === null || chain[0].address < bestStart))
			) {
				bestChain = chain;
			}
		}

		memo.set(endAddress, bestChain);
		return bestChain;
	};

	const bestChain = findBestChainEndingAt(anchorAddress);
	const bestStart = bestChain[0]?.address ?? null;

	if (bestChain.length === 0 || bestStart === null) {
		return [];
	}

	return bestChain.map((decoded) => ({
		address: decoded.address,
		byteLength: decoded.length,
		bytesHex: decoded.bytesHex,
		mnemonic: decoded.mnemonic,
		operands: decoded.operands,
		isCurrent: false,
	}));
};

const totalLoadedBytes = (lines: readonly DisassemblyLine[]) =>
	lines.reduce((sum, line) => sum + line.byteLength, 0);

const loadPreviousWindow = (
	source: DisassemblyMemorySource,
	beforeAddress: bigint,
	rangeStart: bigint,
): PreviousDisassemblyLoadResult => {
	if (beforeAddress <= rangeStart) {
		return {
			lines: [],
			hasMoreBefore: false,
		};
	}

	const lines: DisassemblyLine[] = [];
	let cursor = beforeAddress;
	let loadedBytes = 0;

	while (cursor > rangeStart && loadedBytes < DISASSEMBLY_PAGE_BYTES) {
		const previousLines = buildPreviousGuessLines(source, cursor, rangeStart);
		if (previousLines.length === 0) {
			return {
				lines,
				hasMoreBefore: false,
			};
		}

		lines.unshift(...previousLines);
		loadedBytes += totalLoadedBytes(previousLines);
		const nextCursor = previousLines[0].address;
		if (nextCursor >= cursor) {
			return {
				lines,
				hasMoreBefore: false,
			};
		}

		cursor = nextCursor;
	}

	if (cursor <= rangeStart) {
		return {
			lines,
			hasMoreBefore: false,
		};
	}

	return {
		lines,
		hasMoreBefore: buildPreviousGuessLines(source, cursor, rangeStart).length > 0,
	};
};

const loadForwardWindow = (
	source: DisassemblyMemorySource,
	startAddress: bigint,
	isCurrentStart: boolean,
): NextDisassemblyLoadResult => {
	const match = source.findMemoryRangeAt(startAddress);
	if (!match) {
		return {
			lines: [],
			hasMoreAfter: false,
		};
	}

	const rangeEnd = match.range.address + match.range.dataSize;
	const lines: DisassemblyLine[] = [];
	let cursor = startAddress;
	let loadedBytes = 0;

	while (cursor < rangeEnd && loadedBytes < DISASSEMBLY_PAGE_BYTES) {
		const remaining = rangeEnd - cursor;
		const maxBytes = Number(
			remaining > BigInt(MAX_INSTRUCTION_LENGTH)
				? BigInt(MAX_INSTRUCTION_LENGTH)
				: remaining,
		);
		if (maxBytes <= 0) {
			break;
		}

		const decoded = decodeOrFallbackLine(
			source,
			cursor,
			maxBytes,
			isCurrentStart && cursor === startAddress,
		);
		if (!decoded) {
			break;
		}

		lines.push(decoded.line);
		cursor = decoded.nextAddress;
		loadedBytes += decoded.line.byteLength;
	}

	return {
		lines,
		hasMoreAfter: cursor < rangeEnd,
	};
};

export const resolveDisassemblyContext = (
	dump: MiniDump,
): DebugDisassemblyContext => {
	const processorArchitecture = dump.systemInfo?.processorArchitecture;
	if (processorArchitecture !== undefined && processorArchitecture !== 9) {
		return {
			...baseContext(dump, null, null, null),
			status: "unsupported_arch",
			message: "Disassembly view currently supports x64 dumps only.",
		};
	}

	const resolved = resolveContext(dump);
	const exceptionAddress =
		dump.exceptionStream?.exceptionRecord.exceptionAddress ?? null;
	const rip = resolved.registers?.rip ?? null;
	const instructionPointer =
		exceptionAddress && dump.findMemoryRange(exceptionAddress)
			? exceptionAddress
			: (rip ?? exceptionAddress);

	if (!instructionPointer) {
		return {
			...baseContext(dump, resolved.threadId, resolved.registers, null),
			status: "missing_context",
			message:
				"No x64 thread context or instruction pointer was found in the dump.",
		};
	}

	return {
		...baseContext(
			dump,
			resolved.threadId,
			resolved.registers,
			instructionPointer,
		),
		status: "ok",
		message: "Disassembly context resolved.",
	};
};

export const buildDisassemblyListing = (
	source: DisassemblyMemorySource,
	context: DebugDisassemblyContext,
	anchorAddress: bigint,
): DebugDisassemblyListing => {
	if (context.status === "unsupported_arch") {
		return toListing(context.status, context.message, anchorAddress);
	}

	const anchorMatch = source.findMemoryRangeAt(anchorAddress);
	if (!anchorMatch) {
		return toListing(
			"missing_memory",
			`Address ${fmtAddress(anchorAddress)} is not present in dump memory.`,
			anchorAddress,
		);
	}

	const previousLoad = loadPreviousWindow(
		source,
		anchorAddress,
		anchorMatch.range.address,
	);
	const nextLoad = loadForwardWindow(source, anchorAddress, true);
	const lines = [...previousLoad.lines, ...nextLoad.lines];
	const anchorLineIndex = previousLoad.lines.length;

	if (lines.length <= previousLoad.lines.length) {
		return toListing(
			"decode_error",
			`Failed to decode bytes at ${fmtAddress(anchorAddress)}.`,
			anchorAddress,
		);
	}

	return toListing(
		"ok",
		`Showing guessed disassembly around ${fmtAddress(anchorAddress)}.`,
		anchorAddress,
		lines,
		anchorLineIndex,
		previousLoad.hasMoreBefore,
		nextLoad.hasMoreAfter,
	);
};

export const loadPreviousDisassemblyLines = (
	source: DisassemblyMemorySource,
	beforeAddress: bigint,
): PreviousDisassemblyLoadResult => {
	const match = source.findMemoryRangeAt(beforeAddress);
	if (!match) {
		return {
			lines: [],
			hasMoreBefore: false,
		};
	}

	return loadPreviousWindow(source, beforeAddress, match.range.address);
};

export const loadNextDisassemblyLines = (
	source: DisassemblyMemorySource,
	startAddress: bigint,
): NextDisassemblyLoadResult => loadForwardWindow(source, startAddress, false);
