import { disassembleInstruction, MAX_INSTRUCTION_LENGTH } from "./disassembly";
import type { MinidumpMemoryRangeMatch } from "./minidump";
import { maxU64 } from "./utils";

const DISASSEMBLY_LOOKBACK_BYTES = 256;
const DISASSEMBLY_PAGE_BYTES = 0x1000;

export type DisassemblyStatus = "ok" | "missing_memory" | "decode_error";

export type DisassemblyLine = {
	address: bigint;
	byteLength: number;
	bytesHex: string;
	mnemonic: string;
	operands: string;
	isCurrent: boolean;
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

type LoadedLine = {
	line: DisassemblyLine;
	nextAddress: bigint;
};

const fmtAddress = (value: bigint) =>
	`0x${value.toString(16).toUpperCase().padStart(16, "0")}`;

const formatBytes = (bytes: Uint8Array) =>
	[...bytes]
		.map((value) => value.toString(16).toUpperCase().padStart(2, "0"))
		.join(" ");

const formatDbOperand = (value: number) =>
	`0x${value.toString(16).toUpperCase().padStart(2, "0")}`;

const makeLine = (
	address: bigint,
	byteLength: number,
	bytesHex: string,
	mnemonic: string,
	operands: string,
	isCurrent: boolean,
): DisassemblyLine => ({
	address,
	byteLength,
	bytesHex,
	mnemonic,
	operands,
	isCurrent,
});

const makeListing = (
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

const emptyPreviousLoad = (
	lines: DisassemblyLine[] = [],
	hasMoreBefore = false,
): PreviousDisassemblyLoadResult => ({
	lines,
	hasMoreBefore,
});

const emptyNextLoad = (
	lines: DisassemblyLine[] = [],
	hasMoreAfter = false,
): NextDisassemblyLoadResult => ({
	lines,
	hasMoreAfter,
});

const decodeInstructionAt = (
	source: DisassemblyMemorySource,
	address: bigint,
	maxBytes = MAX_INSTRUCTION_LENGTH,
): DecodedInstruction | null => {
	const bytes = source.readMemoryAt(
		address,
		Math.max(1, Math.min(MAX_INSTRUCTION_LENGTH, Math.floor(maxBytes))),
	);
	if (!bytes || bytes.byteLength === 0) {
		return null;
	}

	const decoded = disassembleInstruction(bytes, address);
	return decoded
		? {
				address,
				length: decoded.length,
				bytesHex: formatBytes(decoded.bytes),
				mnemonic: decoded.mnemonic,
				operands: decoded.operands,
			}
		: null;
};

const decodeLine = (
	source: DisassemblyMemorySource,
	address: bigint,
	maxBytes: number,
	isCurrent: boolean,
): LoadedLine | null => {
	const decoded = decodeInstructionAt(source, address, maxBytes);
	if (decoded) {
		return {
			line: makeLine(
				decoded.address,
				decoded.length,
				decoded.bytesHex,
				decoded.mnemonic,
				decoded.operands,
				isCurrent,
			),
			nextAddress: decoded.address + BigInt(decoded.length),
		};
	}

	const fallback = source.readMemoryAt(address, 1);
	if (!fallback || fallback.byteLength === 0) {
		return null;
	}

	return {
		line: makeLine(
			address,
			1,
			formatBytes(fallback),
			"db",
			formatDbOperand(fallback[0]),
			isCurrent,
		),
		nextAddress: address + 1n,
	};
};

const countLoadedBytes = (lines: readonly DisassemblyLine[]) =>
	lines.reduce((total, line) => total + line.byteLength, 0);

const buildPreviousGuessLines = (
	source: DisassemblyMemorySource,
	endAddress: bigint,
	rangeStart: bigint,
): DisassemblyLine[] => {
	if (endAddress <= rangeStart) {
		console.log("no previous lines 7");
		return [];
	}

	const searchStart = maxU64(
		rangeStart,
		endAddress - BigInt(DISASSEMBLY_LOOKBACK_BYTES),
	);
	const bestChains = new Map<bigint, DecodedInstruction[]>();

	const bestChainEndingAt = (candidateEnd: bigint): DecodedInstruction[] => {
		const cached = bestChains.get(candidateEnd);
		if (cached) {
			return cached;
		}

		let best: DecodedInstruction[] = [];
		const candidateStart = maxU64(
			searchStart,
			candidateEnd - BigInt(MAX_INSTRUCTION_LENGTH),
		);

		for (let start = candidateStart; start < candidateEnd; start += 1n) {
			const instructionLength = Number(candidateEnd - start);
			const decoded = decodeInstructionAt(source, start, instructionLength);
			if (!decoded || decoded.length !== instructionLength) {
				continue;
			}

			const prefix = start > searchStart ? bestChainEndingAt(start) : [];
			const chain = [...prefix, decoded];
			const currentBestStart = best[0]?.address ?? null;
			if (
				chain.length > best.length ||
				(chain.length === best.length &&
					(currentBestStart === null || chain[0].address < currentBestStart))
			) {
				best = chain;
			}
		}

		bestChains.set(candidateEnd, best);
		return best;
	};

	const best = bestChainEndingAt(endAddress);
	console.log("best chains at end address", fmtAddress(endAddress), best);
	return best.map((decoded) =>
		makeLine(
			decoded.address,
			decoded.length,
			decoded.bytesHex,
			decoded.mnemonic,
			decoded.operands,
			false,
		),
	);
};

const loadPreviousWindow = (
	source: DisassemblyMemorySource,
	beforeAddress: bigint,
	rangeStart: bigint,
): PreviousDisassemblyLoadResult => {
	if (beforeAddress <= rangeStart) {
		console.log("no previous lines 3");
		return emptyPreviousLoad();
	}

	const lines: DisassemblyLine[] = [];
	let cursor = beforeAddress;
	let loadedBytes = 0;

	while (cursor > rangeStart && loadedBytes < DISASSEMBLY_PAGE_BYTES) {
		const batch = buildPreviousGuessLines(source, cursor, rangeStart);
		if (batch.length === 0) {
			console.log(
				`no previous lines 4: ${fmtAddress(cursor)} ${fmtAddress(rangeStart)}`,
			);
			return emptyPreviousLoad(lines, false);
		}

		lines.unshift(...batch);
		loadedBytes += countLoadedBytes(batch);
		const nextCursor = batch[0].address;
		if (nextCursor >= cursor) {
			console.log("no previous lines 5");
			return emptyPreviousLoad(lines, false);
		}
		cursor = nextCursor;
	}

	if (cursor <= rangeStart) {
		console.log("no previous lines 6");
		return emptyPreviousLoad(lines, false);
	}

	return emptyPreviousLoad(
		lines,
		buildPreviousGuessLines(source, cursor, rangeStart).length > 0,
	);
};

const loadForwardWindow = (
	source: DisassemblyMemorySource,
	startAddress: bigint,
	isCurrentStart: boolean,
): NextDisassemblyLoadResult => {
	const match = source.findMemoryRangeAt(startAddress);
	if (!match) {
		return emptyNextLoad();
	}

	const rangeEnd = match.range.address + match.range.dataSize;
	const lines: DisassemblyLine[] = [];
	let cursor = startAddress;
	let loadedBytes = 0;

	while (cursor < rangeEnd && loadedBytes < DISASSEMBLY_PAGE_BYTES) {
		const maxBytes = Number(
			rangeEnd - cursor > BigInt(MAX_INSTRUCTION_LENGTH)
				? BigInt(MAX_INSTRUCTION_LENGTH)
				: rangeEnd - cursor,
		);
		if (maxBytes <= 0) {
			break;
		}

		const loaded = decodeLine(
			source,
			cursor,
			maxBytes,
			isCurrentStart && cursor === startAddress,
		);
		if (!loaded) {
			break;
		}

		lines.push(loaded.line);
		cursor = loaded.nextAddress;
		loadedBytes += loaded.line.byteLength;
	}

	return emptyNextLoad(lines, cursor < rangeEnd);
};

export const buildDisassemblyListing = (
	source: DisassemblyMemorySource,
	anchorAddress: bigint,
): DebugDisassemblyListing => {
	const anchorMatch = source.findMemoryRangeAt(anchorAddress);
	if (!anchorMatch) {
		return makeListing(
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
	if (lines.length <= previousLoad.lines.length) {
		return makeListing(
			"decode_error",
			`Failed to decode bytes at ${fmtAddress(anchorAddress)}.`,
			anchorAddress,
		);
	}

	return makeListing(
		"ok",
		`Showing guessed disassembly around ${fmtAddress(anchorAddress)}.`,
		anchorAddress,
		lines,
		previousLoad.lines.length,
		previousLoad.hasMoreBefore,
		nextLoad.hasMoreAfter,
	);
};

export const loadPreviousDisassemblyLines = (
	source: DisassemblyMemorySource,
	beforeAddress: bigint,
): PreviousDisassemblyLoadResult => {
	const match = source.findMemoryRangeAt(beforeAddress);
	return match
		? loadPreviousWindow(source, beforeAddress, match.range.address)
		: emptyPreviousLoad();
};

export const loadNextDisassemblyLines = (
	source: DisassemblyMemorySource,
	startAddress: bigint,
): NextDisassemblyLoadResult => loadForwardWindow(source, startAddress, false);
