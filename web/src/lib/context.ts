import type { Context } from "./cpu_context";
import type { DebugInterface, DebugThread } from "./debug_interface";
import { assert } from "./utils";

export { CONTEXT_AMD64, Context } from "./cpu_context";

export type ResolvedContextStatus =
	| "ok"
	| "unsupported_arch"
	| "missing_context";

export type ResolvedDumpContext = {
	threadId: number | null;
	threadContext: Context | null;
	instructionPointer: bigint | null;
	anchorAddress: bigint | null;
	exceptionAddress: bigint | null;
	exceptionCode: number | null;
};

type ResolvedThreadContext = {
	threadId: number | null;
	threadContext: Context | null;
};

export type ContextResolvableDebugInterface = DebugInterface & {
	systemInfo?: { processorArchitecture: number } | null;
	exceptionInfo?: {
		exceptionRecord: {
			exceptionCode: number;
			exceptionAddress: bigint;
		};
	} | null;
};

const MEMORY_PROBE_SIZE = 0x10;

export const tryThreadContext = (
	thread: DebugThread,
): ResolvedThreadContext | null => {
	if (!thread.context) return null;
	return { threadId: thread.id, threadContext: thread.context };
};

const resolveThreadContext = (
	debugInterface: DebugInterface,
): ResolvedThreadContext => {
	const currentThreadId = debugInterface.dm.currentThreadId || null;

	if (debugInterface.dm.currentContext !== null) {
		return {
			threadId: currentThreadId,
			threadContext: debugInterface.dm.currentContext,
		};
	}

	if (currentThreadId !== null) {
		const currentThread = debugInterface.dm.threads.find(
			(thread) => thread.id === currentThreadId,
		);
		const resolvedCurrentThread = currentThread
			? tryThreadContext(currentThread)
			: null;
		if (resolvedCurrentThread) {
			return resolvedCurrentThread;
		}
	}

	for (const thread of debugInterface.dm.threads) {
		const resolved = tryThreadContext(thread);
		if (resolved) {
			return resolved;
		}
	}

	return {
		threadId: currentThreadId,
		threadContext: null,
	};
};

export const resolveContextForThread = async (
	debugInterface: ContextResolvableDebugInterface,
	threadId: number,
): Promise<ResolvedDumpContext | null> => {
	const thread = debugInterface.dm.threads.find((t) => t.id === threadId);
	if (!thread) return null;
	const resolved = tryThreadContext(thread);
	if (!resolved?.threadContext) return null;
	const ip = resolved.threadContext.ip;
	const exceptionAddress =
		debugInterface.exceptionInfo?.exceptionRecord.exceptionAddress ?? null;
	const exceptionCode =
		debugInterface.exceptionInfo?.exceptionRecord.exceptionCode ?? null;
	let anchorAddress: bigint | null = ip;
	if (exceptionAddress !== null) {
		try {
			await debugInterface.read(exceptionAddress, MEMORY_PROBE_SIZE, 1);
			anchorAddress = exceptionAddress;
		} catch {
			anchorAddress = ip;
		}
	}
	return {
		threadId,
		threadContext: resolved.threadContext,
		instructionPointer: ip,
		anchorAddress,
		exceptionAddress,
		exceptionCode,
	};
};

export const resolveDumpContext = async (
	debugInterface: ContextResolvableDebugInterface,
): Promise<ResolvedDumpContext> => {
	const processorArchitecture =
		debugInterface.systemInfo?.processorArchitecture ?? 0;
	assert(processorArchitecture === 9, "Only x64 dumps are supported");

	const resolved = resolveThreadContext(debugInterface);

	const exceptionCode =
		debugInterface.exceptionInfo?.exceptionRecord.exceptionCode ?? null;
	const exceptionAddress =
		debugInterface.exceptionInfo?.exceptionRecord.exceptionAddress ?? null;
	const instructionPointer = resolved.threadContext?.ip ?? null;
	let anchorAddress = instructionPointer;
	if (exceptionAddress !== null) {
		try {
			await debugInterface.read(exceptionAddress, MEMORY_PROBE_SIZE, 1);
			anchorAddress = exceptionAddress;
		} catch {
			anchorAddress = instructionPointer;
		}
	}

	return {
		threadId: resolved.threadId,
		threadContext: resolved.threadContext,
		instructionPointer,
		anchorAddress,
		exceptionAddress,
		exceptionCode,
	};
};
