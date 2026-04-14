import type { DebugInterface, DebugModule } from "./debug_interface";
import {
	AMD64_MAX_INSTR_LEN,
	decodeInstruction,
	decodeInstructionLength,
	type InstrTextSegment,
	maxInstructionLength,
	seg,
} from "./disassembly";
import { fmtHex, fmtHex16 } from "./formatting";
import { resolveSymbol, symbolicateSegments } from "./symbolication";
import { maxU64 } from "./utils";

const DISASSEMBLY_LOOKBACK_BYTES = 256;
const DISASSEMBLY_PAGE_BYTES = 0x1000;

export type DisassemblyStatus = "ok" | "missing_memory" | "decode_error";

export type DisassemblyLine = {
	address: bigint;
	byteLength: number;
	bytesHex: string;
	mnemonic: string;
	operandSegments: InstrTextSegment[];
	directTargetAddress: bigint | null;
	ripRelativeTargets: bigint[];
	isCurrent: boolean;
	symbol?: string;
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

type LoadedLine = {
	line: DisassemblyLine;
	nextAddress: bigint;
};

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

type DecodedLineBase = Omit<DisassemblyLine, "isCurrent">;

const decodeInstructionAt = async (
	source: DisassemblyMemorySource,
	address: bigint,
	maxBytes = AMD64_MAX_INSTR_LEN,
	arch: number,
): Promise<DecodedLineBase | null> => {
	const maxLen = maxInstructionLength(arch);
	const requestedSize = Math.max(1, Math.min(maxLen, Math.floor(maxBytes)));

	let bytes: Uint8Array;
	try {
		bytes = await source.read(address, requestedSize, 1);
	} catch {
		return null;
	}

	const decoded = decodeInstruction(bytes, address, arch);
	if (!decoded) return null;

	return {
		address,
		byteLength: decoded.length,
		bytesHex: [...decoded.bytes].map((b) => fmtHex(b, 2)).join(" "),
		mnemonic: decoded.mnemonic,
		operandSegments: decoded.operandSegments,
		directTargetAddress: decoded.controlFlow.directTargetAddress,
		ripRelativeTargets: decoded.ripRelativeTargets,
	};
};

const decodeLine = async (
	source: DisassemblyMemorySource,
	address: bigint,
	maxBytes: number,
	isCurrent: boolean,
	arch: number,
): Promise<LoadedLine | null> => {
	const decoded = await decodeInstructionAt(source, address, maxBytes, arch);
	if (decoded) {
		return {
			line: { ...decoded, isCurrent },
			nextAddress: decoded.address + BigInt(decoded.byteLength),
		};
	}

	const maxLen = maxInstructionLength(arch);
	const requestedSize = Math.max(1, Math.min(maxLen, Math.floor(maxBytes)));

	let fallback: Uint8Array;
	try {
		fallback = await source.read(address, requestedSize, 1);
	} catch {
		return null;
	}

	const fallbackHex = "0x" + fmtHex(fallback[0], 2);
	return {
		line: {
			address,
			byteLength: 1,
			bytesHex: fmtHex(fallback[0], 2),
			mnemonic: "db",
			operandSegments: [seg(fallbackHex, "number")],
			directTargetAddress: null,
			ripRelativeTargets: [],
			isCurrent,
		},
		nextAddress: address + 1n,
	};
};

const countLoadedBytes = (lines: readonly DisassemblyLine[]) =>
	lines.reduce((total, line) => total + line.byteLength, 0);

async function annotateSymbols(
	lines: DisassemblyLine[],
	modules: readonly DebugModule[],
): Promise<void> {
	const promises: Promise<void>[] = [];
	for (const line of lines) {
		promises.push(
			resolveSymbol(line.address, modules).then((s) => {
				line.symbol = s;
			}),
		);
		const targetAddresses = [
			...(line.directTargetAddress !== null ? [line.directTargetAddress] : []),
			...line.ripRelativeTargets,
		];
		if (targetAddresses.length > 0) {
			promises.push(
				symbolicateSegments(line.operandSegments, targetAddresses, modules),
			);
		}
	}
	await Promise.all(promises);
}

const buildPreviousGuessLines = async (
	source: DisassemblyMemorySource,
	endAddress: bigint,
	arch: number,
): Promise<DisassemblyLine[]> => {
	if (endAddress <= 0n) {
		return [];
	}

	const maxLen = maxInstructionLength(arch);
	const searchStart = maxU64(
		0n,
		endAddress - BigInt(DISASSEMBLY_LOOKBACK_BYTES),
	);

	type LengthChain = { address: bigint; length: number }[];
	const bestChains = new Map<bigint, Promise<LengthChain>>();

	const bestChainEndingAt = (candidateEnd: bigint): Promise<LengthChain> => {
		const cached = bestChains.get(candidateEnd);
		if (cached) return cached;

		const chainPromise = (async () => {
			let best: LengthChain = [];
			const candidateStart = maxU64(searchStart, candidateEnd - BigInt(maxLen));

			for (let start = candidateStart; start < candidateEnd; start += 1n) {
				const span = Number(candidateEnd - start);

				let bytes: Uint8Array;
				try {
					bytes = await source.read(start, span, span);
				} catch {
					continue;
				}

				const length = decodeInstructionLength(bytes, arch);
				if (length !== span) continue;

				const prefix =
					start > searchStart ? await bestChainEndingAt(start) : [];
				const chain = [...prefix, { address: start, length }];
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

	const chain = await bestChainEndingAt(endAddress);

	const lines: DisassemblyLine[] = [];
	for (const entry of chain) {
		const decoded = await decodeInstructionAt(
			source,
			entry.address,
			maxLen,
			arch,
		);
		if (decoded) {
			lines.push({ ...decoded, isCurrent: false });
		}
	}
	return lines;
};

const loadPreviousWindow = async (
	source: DisassemblyMemorySource,
	beforeAddress: bigint,
	arch: number,
): Promise<PreviousDisassemblyLoadResult> => {
	if (beforeAddress <= 0n) {
		return emptyPreviousLoad();
	}

	const lines: DisassemblyLine[] = [];
	let cursor = beforeAddress;
	let loadedBytes = 0;
	let hasMoreBefore = false;
	let exhausted = false;

	while (cursor > 0n && loadedBytes < DISASSEMBLY_PAGE_BYTES) {
		const batch = await buildPreviousGuessLines(source, cursor, arch);
		if (batch.length === 0) {
			exhausted = true;
			break;
		}

		lines.unshift(...batch);
		loadedBytes += countLoadedBytes(batch);
		const nextCursor = batch[0].address;
		if (nextCursor >= cursor) {
			exhausted = true;
			break;
		}
		cursor = nextCursor;
	}

	if (!exhausted && cursor > 0n) {
		hasMoreBefore =
			(await buildPreviousGuessLines(source, cursor, arch)).length > 0;
	}

	if (lines.length > 0) {
		await annotateSymbols(lines, source.modules.state);
	}

	return emptyPreviousLoad(lines, hasMoreBefore);
};

const loadForwardWindow = async (
	source: DisassemblyMemorySource,
	startAddress: bigint,
	isCurrentStart: boolean,
	arch: number,
): Promise<NextDisassemblyLoadResult> => {
	const maxLen = maxInstructionLength(arch);
	const lines: DisassemblyLine[] = [];
	let cursor = startAddress;
	let loadedBytes = 0;

	while (loadedBytes < DISASSEMBLY_PAGE_BYTES) {
		const loaded = await decodeLine(
			source,
			cursor,
			maxLen,
			isCurrentStart && cursor === startAddress,
			arch,
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
		hasMoreAfter = (await source.read(cursor, maxLen, 1)).byteLength > 0;
	} catch {
		hasMoreAfter = false;
	}

	if (lines.length > 0) {
		await annotateSymbols(lines, source.modules.state);
	}

	return emptyNextLoad(lines, hasMoreAfter);
};

export const buildDisassemblyListing = async (
	source: DisassemblyMemorySource,
	anchorAddress: bigint,
	arch: number,
): Promise<DebugDisassemblyListing> => {
	const maxLen = maxInstructionLength(arch);
	try {
		if ((await source.read(anchorAddress, maxLen, 1)).byteLength === 0) {
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

	const previousLoad = await loadPreviousWindow(source, anchorAddress, arch);
	const nextLoad = await loadForwardWindow(source, anchorAddress, true, arch);
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
	arch: number,
): Promise<PreviousDisassemblyLoadResult> =>
	loadPreviousWindow(source, beforeAddress, arch);

export const loadNextDisassemblyLines = async (
	source: DisassemblyMemorySource,
	startAddress: bigint,
	arch: number,
): Promise<NextDisassemblyLoadResult> =>
	loadForwardWindow(source, startAddress, false, arch);
