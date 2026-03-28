import type { DebugInterface } from "./debug_interface";
import { disassembleInstruction, MAX_INSTRUCTION_LENGTH } from "./disassembly";
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

const decodeInstructionAt = async (
	source: DisassemblyMemorySource,
	address: bigint,
	maxBytes = MAX_INSTRUCTION_LENGTH,
): Promise<DecodedInstruction | null> => {
	for (
		let size = Math.max(
			1,
			Math.min(MAX_INSTRUCTION_LENGTH, Math.floor(maxBytes)),
		);
		size >= 1;
		size -= 1
	) {
		let bytes: Uint8Array;
		try {
			bytes = await source.read(address, size);
		} catch {
			continue;
		}

		if (bytes.byteLength === 0) {
			continue;
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
	}

	return null;
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

	let fallback: Uint8Array;
	try {
		fallback = await source.read(address, 1);
	} catch {
		return null;
	}

	if (fallback.byteLength === 0) {
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

const buildPreviousGuessLines = async (
	source: DisassemblyMemorySource,
	endAddress: bigint,
): Promise<DisassemblyLine[]> => {
	if (endAddress <= 0n) {
		return [];
	}

	const searchStart = maxU64(0n, endAddress - BigInt(DISASSEMBLY_LOOKBACK_BYTES));
	const bestChains = new Map<bigint, Promise<DecodedInstruction[]>>();

	const bestChainEndingAt = (candidateEnd: bigint): Promise<DecodedInstruction[]> => {
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
				const decoded = await decodeInstructionAt(source, start, instructionLength);
				if (!decoded || decoded.length !== instructionLength) {
					continue;
				}

				const prefix = start > searchStart ? await bestChainEndingAt(start) : [];
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
		hasMoreAfter = (await source.read(cursor, 1)).byteLength > 0;
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
		const anchorByte = await source.read(anchorAddress, 1);
		if (anchorByte.byteLength === 0) {
			return makeListing(
				"missing_memory",
				`Address ${fmtAddress(anchorAddress)} is not present in dump memory.`,
				anchorAddress,
			);
		}
	} catch {
		return makeListing(
			"missing_memory",
			`Address ${fmtAddress(anchorAddress)} is not present in dump memory.`,
			anchorAddress,
		);
	}

	const previousLoad = await loadPreviousWindow(source, anchorAddress);
	const nextLoad = await loadForwardWindow(source, anchorAddress, true);
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
