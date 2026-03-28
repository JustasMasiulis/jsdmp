import { type ResolvedDumpContext, resolveDumpContext } from "./context";
import { MiniDump } from "./minidump";
import { MinidumpDebugInterface } from "./minidump_debug_interface";

export const ALLOWED_DUMP_EXTENSIONS = [".dmp", ".mdmp", ".dump"] as const;

export type ParsedDumpInfo = {
	debugInterface: MinidumpDebugInterface;
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

export const buildParsedDumpInfo = async (
	parsed: MiniDump,
): Promise<ParsedDumpInfo> => {
	const debugInterface = new MinidumpDebugInterface(parsed);
	let resolvedContext: ResolvedDumpContext | null = null;
	let contextWarning: string | null = null;

	try {
		resolvedContext = await resolveDumpContext(debugInterface);
	} catch (error) {
		contextWarning = error instanceof Error ? error.message : String(error);
	}

	return {
		debugInterface,
		resolvedContext,
		contextWarning,
	};
};

export const parseDumpFile = async (file: File): Promise<ParsedDumpInfo> => {
	const data = await file.arrayBuffer();
	return buildParsedDumpInfo(new MiniDump(data));
};
