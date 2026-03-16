import type {
	MiniDump,
	MinidumpAssociatedThread,
	MinidumpLocationDescriptor,
} from "./minidump";
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

const readContextFromLocation = (
	dump: MiniDump,
	location: MinidumpLocationDescriptor | null | undefined,
): Context | null => {
	if (!location) {
		return null;
	}

	const view = dump.readLocationView(location);
	if (!view) {
		return null;
	}

	try {
		return new Context(view);
	} catch {
		return null;
	}
};

const resolveThreadContext = (dump: MiniDump): ResolvedThreadContext => {
	const exceptionThreadId = dump.exceptionStream?.threadId ?? null;
	const exceptionContext = readContextFromLocation(
		dump,
		dump.exceptionStream?.threadContext,
	);
	if (exceptionContext) {
		return {
			threadId: exceptionThreadId,
			threadContext: exceptionContext,
		};
	}

	const tryThread = (
		thread: MinidumpAssociatedThread,
	): ResolvedThreadContext | null => {
		const threadContext = readContextFromLocation(dump, thread.threadContext);
		return threadContext
			? {
					threadId: thread.threadId,
					threadContext,
				}
			: null;
	};

	if (exceptionThreadId !== null) {
		const exceptionThread = (dump.associatedThreads ?? []).find(
			(thread) => thread.threadId === exceptionThreadId,
		);
		const resolved = exceptionThread ? tryThread(exceptionThread) : null;
		if (resolved) {
			return resolved;
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
		threadContext: null,
	};
};

export const resolveDumpContext = (dump: MiniDump): ResolvedDumpContext => {
	const processorArchitecture = dump.systemInfo?.processorArchitecture ?? 0;
	assert(processorArchitecture === 9, "Only x64 dumps are supported");

	const resolved = resolveThreadContext(dump);

	const exceptionCode =
		dump.exceptionStream?.exceptionRecord.exceptionCode ?? null;
	const exceptionAddress =
		dump.exceptionStream?.exceptionRecord.exceptionAddress ?? null;
	const instructionPointer = resolved.threadContext?.ip ?? null;
	const anchorAddress =
		exceptionAddress !== null && dump.findMemoryRange(exceptionAddress)
			? exceptionAddress
			: instructionPointer;

	return {
		threadId: resolved.threadId,
		threadContext: resolved.threadContext,
		instructionPointer,
		anchorAddress,
		exceptionAddress,
		exceptionCode,
	};
};
