import type {
	DebugInterface,
	DebugThread,
} from "./debug_interface";
import { readU16, readU32, readU64 } from "./reader";
import { assert } from "./utils";

export const CONTEXT_AMD64 = 0x00100000;

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
	exceptionInfo?:
		| {
				exceptionRecord: {
					exceptionCode: number;
					exceptionAddress: bigint;
				};
		  }
		| null;
};

const AMD64_CONTEXT_MIN_SIZE = 0x100;
const MEMORY_PROBE_SIZE = 0x10;

export class Context {
	private _data: DataView;

	constructor(data: ArrayBuffer | ArrayBufferView) {
		this._data =
			data instanceof DataView
				? data
				: ArrayBuffer.isView(data)
					? new DataView(data.buffer, data.byteOffset, data.byteLength)
					: new DataView(data);

		if ((this.context_flags & CONTEXT_AMD64) !== CONTEXT_AMD64) {
			throw new Error("Invalid context flags");
		}
	}

	get context_flags(): number {
		return readU32(this._data, 0x30);
	}

	get flags(): number {
		return readU32(this._data, 0x44);
	}

	get ip(): bigint {
		return readU64(this._data, 0xf8);
	}

	get sp(): bigint {
		return readU64(this._data, 0x98);
	}

	gpr(idx: number): bigint {
		return readU64(this._data, 0x78 + idx * 8);
	}

	seg(idx: number): number {
		return readU16(this._data, 0x38 + idx * 2);
	}
}

const readContextFromAddress = async (
	debugInterface: DebugInterface,
	address: bigint,
): Promise<Context | null> => {
	if (address === 0n) {
		return null;
	}

	try {
		return new Context(await debugInterface.read(address, AMD64_CONTEXT_MIN_SIZE));
	} catch {
		return null;
	}
};

export const tryThreadContext = async (
	debugInterface: DebugInterface,
	thread: DebugThread,
): Promise<ResolvedThreadContext | null> => {
	const threadContext = await readContextFromAddress(
		debugInterface,
		thread.context,
	);
	return threadContext
		? {
				threadId: thread.id,
				threadContext,
			}
		: null;
};

const resolveThreadContext = async (
	debugInterface: DebugInterface,
): Promise<ResolvedThreadContext> => {
	const currentThreadId = debugInterface.dm.currentThreadId || null;

	if (debugInterface.dm.currentContext !== 0n) {
		const currentContext = await readContextFromAddress(
			debugInterface,
			debugInterface.dm.currentContext,
		);
		if (currentContext) {
			return {
				threadId: currentThreadId,
				threadContext: currentContext,
			};
		}
	}

	if (currentThreadId !== null) {
		const currentThread = debugInterface.dm.threads.find(
			(thread) => thread.id === currentThreadId,
		);
		const resolvedCurrentThread = currentThread
			? await tryThreadContext(debugInterface, currentThread)
			: null;
		if (resolvedCurrentThread) {
			return resolvedCurrentThread;
		}
	}

	for (const thread of debugInterface.dm.threads) {
		const resolved = await tryThreadContext(debugInterface, thread);
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
	const resolved = await tryThreadContext(debugInterface, thread);
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

	const resolved = await resolveThreadContext(debugInterface);

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
