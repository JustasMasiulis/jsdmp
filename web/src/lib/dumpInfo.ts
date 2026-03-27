import { type ResolvedDumpContext, resolveDumpContext } from "./context";
import {
	MiniDump,
	type MinidumpAssociatedThread,
	type MinidumpExceptionStream,
	type MinidumpMemory64Range,
	type MinidumpMemoryRangeMatch,
	type MinidumpMemoryReadView,
	type MinidumpMiscInfo,
	type MinidumpModule,
	type MinidumpSystemInfo,
	type MinidumpUnloadedModule,
} from "./minidump";

export const ALLOWED_DUMP_EXTENSIONS = [".dmp", ".mdmp", ".dump"] as const;

export type ParsedDumpInfo = {
	checksum: number;
	timestamp: number;
	flags: bigint;
	streamCount: number;
	streamTypes: number[];
	systemInfo: MinidumpSystemInfo | null;
	miscInfo: MinidumpMiscInfo | null;
	exceptionStream: MinidumpExceptionStream | null;
	associatedThreads: MinidumpAssociatedThread[] | null;
	moduleList: MinidumpModule[] | null;
	unloadedModuleList: MinidumpUnloadedModule[] | null;
	memoryRanges: MinidumpMemory64Range[];
	readMemoryAt: (address: bigint, size: number) => Uint8Array | null;
	readMemoryViewAt: (
		address: bigint,
		size: number,
		hintRangeIndex?: number,
	) => MinidumpMemoryReadView | null;
	findMemoryRangeAt: (
		address: bigint,
		hintRangeIndex?: number,
	) => MinidumpMemoryRangeMatch | null;
	resolvedContext: ResolvedDumpContext | null;
	contextWarning: string | null;
};

export const formatDumpFileSize = (bytes: number): string => {
	if (bytes < 1024) {
		return `${bytes} B`;
	}
	if (bytes < 1024 * 1024) {
		return `${(bytes / 1024).toFixed(1)} KB`;
	}
	if (bytes < 1024 * 1024 * 1024) {
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	}
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
};

export const isSupportedDumpFile = (file: Pick<File, "name">): boolean => {
	const lowerName = file.name.toLowerCase();
	return ALLOWED_DUMP_EXTENSIONS.some((extension) =>
		lowerName.endsWith(extension),
	);
};

export const buildParsedDumpInfo = (parsed: MiniDump): ParsedDumpInfo => {
	let resolvedContext: ResolvedDumpContext | null = null;
	let contextWarning: string | null = null;

	try {
		resolvedContext = resolveDumpContext(parsed);
	} catch (error) {
		contextWarning = error instanceof Error ? error.message : String(error);
	}

	return {
		checksum: parsed.checksum,
		timestamp: parsed.timestamp,
		flags: parsed.flags,
		streamCount: parsed.streams.size,
		streamTypes: [...parsed.streams.keys()].sort((left, right) => left - right),
		systemInfo: parsed.systemInfo,
		miscInfo: parsed.miscInfo,
		exceptionStream: parsed.exceptionStream,
		associatedThreads: parsed.associatedThreads,
		moduleList: parsed.moduleList,
		unloadedModuleList: parsed.unloadedModuleList,
		memoryRanges: parsed.memoryRanges,
		readMemoryAt: parsed.readMemoryAt.bind(parsed),
		readMemoryViewAt: parsed.readMemoryViewAt.bind(parsed),
		findMemoryRangeAt: parsed.findMemoryRangeAt.bind(parsed),
		resolvedContext,
		contextWarning,
	};
};

export const parseDumpFile = async (file: File): Promise<ParsedDumpInfo> => {
	const data = await file.arrayBuffer();
	return buildParsedDumpInfo(new MiniDump(data));
};
