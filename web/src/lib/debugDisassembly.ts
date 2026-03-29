import type { DebugInterface } from "./debug_interface";
import { disassembleInstruction, MAX_INSTRUCTION_LENGTH } from "./disassembly";
import { fmtHex, fmtHex16 } from "./formatting";
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

export type DisassemblyMemorySource = DebugInterface;

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

const decodeInstructionAt = async (
	source: DisassemblyMemorySource,
	address: bigint,
	maxBytes = MAX_INSTRUCTION_LENGTH,
): Promise<DecodedInstruction | null> => {
	const requestedSize = Math.max(
		1,
		Math.min(MAX_INSTRUCTION_LENGTH, Math.floor(maxBytes)),
	);

	let bytes: Uint8Array;
	try {
		bytes = await source.read(address, requestedSize, 1);
	} catch {
		return null;
	}

	const decoded = disassembleInstruction(bytes, address);
	return decoded
		? {
				address,
				length: decoded.length,
				bytesHex: [...decoded.bytes].map((b) => fmtHex(b, 2)).join(" "),
				mnemonic: decoded.mnemonic,
				operands: decoded.operands,
			}
		: null;
};

const decodeLine = async (
	source: DisassemblyMemorySource,
	address: bigint,
	maxBytes: number,
	isCurrent: boolean,
): Promise<LoadedLine | null> => {
	const decoded = await decodeInstructionAt(source, address, maxBytes);
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

	const requestedSize = Math.max(
		1,
		Math.min(MAX_INSTRUCTION_LENGTH, Math.floor(maxBytes)),
	);

	let fallback: Uint8Array;
	try {
		fallback = await source.read(address, requestedSize, 1);
	} catch {
		return null;
	}

	return {
		line: makeLine(
			address,
			1,
			fmtHex(fallback[0], 2),
			"db",
			`0x${fmtHex(fallback[0], 2)}`,
			isCurrent,
		),
		nextAddress: address + 1n,
	};
};

const countLoadedBytes = (lines: readonly DisassemblyLine[]) =>
	lines.reduce((total, line) => total + line.byteLength, 0);

const buildPreviousGuessLines = async (
	source: DisassemblyMemorySource,
	endAddress: bigint,
): Promise<DisassemblyLine[]> => {
	if (endAddress <= 0n) {
		return [];
	}

	const searchStart = maxU64(
		0n,
		endAddress - BigInt(DISASSEMBLY_LOOKBACK_BYTES),
	);
	const bestChains = new Map<bigint, Promise<DecodedInstruction[]>>();

	const bestChainEndingAt = (
		candidateEnd: bigint,
	): Promise<DecodedInstruction[]> => {
		const cached = bestChains.get(candidateEnd);
		if (cached) {
			return cached;
		}

		const chainPromise = (async () => {
			let best: DecodedInstruction[] = [];
			const candidateStart = maxU64(
				searchStart,
				candidateEnd - BigInt(MAX_INSTRUCTION_LENGTH),
			);

			for (let start = candidateStart; start < candidateEnd; start += 1n) {
				const instructionLength = Number(candidateEnd - start);
				const decoded = await decodeInstructionAt(
					source,
					start,
					instructionLength,
				);
				if (!decoded || decoded.length !== instructionLength) {
					continue;
				}

				const prefix =
					start > searchStart ? await bestChainEndingAt(start) : [];
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

			return best;
		})();

		bestChains.set(candidateEnd, chainPromise);
		return chainPromise;
	};

	return (await bestChainEndingAt(endAddress)).map((decoded) =>
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

const loadPreviousWindow = async (
	source: DisassemblyMemorySource,
	beforeAddress: bigint,
): Promise<PreviousDisassemblyLoadResult> => {
	if (beforeAddress <= 0n) {
		return emptyPreviousLoad();
	}

	const lines: DisassemblyLine[] = [];
	let cursor = beforeAddress;
	let loadedBytes = 0;

	while (cursor > 0n && loadedBytes < DISASSEMBLY_PAGE_BYTES) {
		const batch = await buildPreviousGuessLines(source, cursor);
		if (batch.length === 0) {
			return emptyPreviousLoad(lines, false);
		}

		lines.unshift(...batch);
		loadedBytes += countLoadedBytes(batch);
		const nextCursor = batch[0].address;
		if (nextCursor >= cursor) {
			return emptyPreviousLoad(lines, false);
		}
		cursor = nextCursor;
	}

	if (cursor <= 0n) {
		return emptyPreviousLoad(lines, false);
	}

	return emptyPreviousLoad(
		lines,
		(await buildPreviousGuessLines(source, cursor)).length > 0,
	);
};

const loadForwardWindow = async (
	source: DisassemblyMemorySource,
	startAddress: bigint,
	isCurrentStart: boolean,
): Promise<NextDisassemblyLoadResult> => {
	const lines: DisassemblyLine[] = [];
	let cursor = startAddress;
	let loadedBytes = 0;

	while (loadedBytes < DISASSEMBLY_PAGE_BYTES) {
		const loaded = await decodeLine(
			source,
			cursor,
			MAX_INSTRUCTION_LENGTH,
			isCurrentStart && cursor === startAddress,
		);
		if (!loaded) {
			break;
		}

		lines.push(loaded.line);
		loadedBytes += loaded.line.byteLength;
		if (loaded.nextAddress <= cursor) {
			break;
		}
		cursor = loaded.nextAddress;
	}

	let hasMoreAfter = false;
	try {
		hasMoreAfter =
			(await source.read(cursor, MAX_INSTRUCTION_LENGTH, 1)).byteLength > 0;
	} catch {
		hasMoreAfter = false;
	}

	return emptyNextLoad(lines, hasMoreAfter);
};

export const buildDisassemblyListing = async (
	source: DisassemblyMemorySource,
	anchorAddress: bigint,
): Promise<DebugDisassemblyListing> => {
	try {
		if (
			(await source.read(anchorAddress, MAX_INSTRUCTION_LENGTH, 1))
				.byteLength === 0
		) {
			return makeListing(
				"missing_memory",
				`Address ${`0x${fmtHex16(anchorAddress)}`} is not present in dump memory.`,
				anchorAddress,
			);
		}
	} catch {
		return makeListing(
			"missing_memory",
			`Address ${`0x${fmtHex16(anchorAddress)}`} is not present in dump memory.`,
			anchorAddress,
		);
	}

	const previousLoad = await loadPreviousWindow(source, anchorAddress);
	const nextLoad = await loadForwardWindow(source, anchorAddress, true);
	const lines = [...previousLoad.lines, ...nextLoad.lines];
	if (lines.length <= previousLoad.lines.length) {
		return makeListing(
			"decode_error",
			`Failed to decode bytes at ${`0x${fmtHex16(anchorAddress)}`}.`,
			anchorAddress,
		);
	}

	return makeListing(
		"ok",
		`Showing guessed disassembly around ${`0x${fmtHex16(anchorAddress)}`}.`,
		anchorAddress,
		lines,
		previousLoad.lines.length,
		previousLoad.hasMoreBefore,
		nextLoad.hasMoreAfter,
	);
};

export const loadPreviousDisassemblyLines = async (
	source: DisassemblyMemorySource,
	beforeAddress: bigint,
): Promise<PreviousDisassemblyLoadResult> =>
	loadPreviousWindow(source, beforeAddress);

export const loadNextDisassemblyLines = async (
	source: DisassemblyMemorySource,
	startAddress: bigint,
): Promise<NextDisassemblyLoadResult> =>
	loadForwardWindow(source, startAddress, false);
