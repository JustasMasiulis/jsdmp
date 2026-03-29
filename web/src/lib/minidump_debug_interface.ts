import { Context } from "./cpu_context";
import type {
	DebugInterface,
	DebugMemoryRange,
	DebugModule,
	DebugThread,
	DebugThreadException,
	DebugUnloadedModule,
} from "./debug_interface";
import {
	type MiniDump,
	MiniDumpStreamType,
	type MinidumpAssociatedThread,
	type MinidumpCodeViewInfo,
	type MinidumpExceptionStream,
	type MinidumpMiscInfo,
	type MinidumpModule,
	type MinidumpSystemInfo,
	type MinidumpUnloadedModule,
} from "./minidump";
import { Signal } from "./reactive";
import { readFromModuleImage } from "./symbolServer";
import { assert } from "./utils";

export type MinidumpDebugSystemInfo = MinidumpSystemInfo;
export type MinidumpDebugMiscInfo = MinidumpMiscInfo;

type MinidumpLocation = {
	size: number;
	rva: number;
};

export type MinidumpDebugExceptionInfo = {
	threadId: number;
	exceptionRecord: {
		exceptionCode: number;
		exceptionFlags: number;
		exceptionRecord: bigint;
		exceptionAddress: bigint;
		numberParameters: number;
		exceptionInformation: bigint[];
	};
	contextLocation: MinidumpLocation;
	context: Context | null;
};

export type MinidumpDebugSource = Pick<
	MiniDump,
	| "checksum"
	| "timestamp"
	| "flags"
	| "streams"
	| "systemInfo"
	| "miscInfo"
	| "associatedThreads"
	| "exceptionStream"
	| "moduleList"
	| "unloadedModuleList"
	| "memoryRanges"
	| "readLocationBytes"
	| "readMemoryAt"
>;

const EMPTY_LOCATION: MinidumpLocation = {
	size: 0,
	rva: 0,
};

const toMinidumpLocation = (
	location?: { dataSize: number; rva: number } | null,
): MinidumpLocation =>
	location
		? {
				size: location.dataSize,
				rva: location.rva,
			}
		: EMPTY_LOCATION;

const toDebugMemoryRange = (range: {
	address: bigint;
	dataSize: bigint;
}): DebugMemoryRange => ({
	address: range.address,
	size: range.dataSize,
});

const toDebugCodeViewPdb = (
	codeViewInfo: MinidumpCodeViewInfo | null,
): DebugModule["pdb"] => {
	if (!codeViewInfo || codeViewInfo.format !== "RSDS") {
		return undefined;
	}

	return {
		path: codeViewInfo.pdbFileName,
		guid: codeViewInfo.guid,
		age: codeViewInfo.age,
	};
};

const toDebugModule = (module: MinidumpModule): DebugModule => ({
	address: module.baseOfImage,
	size: module.sizeOfImage,
	checksum: module.checkSum,
	timeDateStamp: module.timeDateStamp,
	path: module.moduleName,
	pdb: toDebugCodeViewPdb(module.codeViewInfo),
});

const toDebugUnloadedModule = (
	module: MinidumpUnloadedModule,
): DebugUnloadedModule => ({
	address: module.baseOfImage,
	size: module.sizeOfImage,
	checksum: module.checkSum,
	timeDateStamp: module.timeDateStamp,
	path: module.moduleName,
});

const toDebugThread = (
	thread: MinidumpAssociatedThread,
	context: Context | null,
	exception: DebugThreadException | null,
): DebugThread => ({
	id: thread.threadId,
	suspendCount: thread.suspendCount ?? 0,
	priorityClass: thread.priorityClass ?? 0,
	priority: thread.priority ?? 0,
	teb: thread.teb ?? 0n,
	stack: {
		address: thread.stack?.startOfMemoryRange ?? 0n,
	},
	context,
	exception,
	dumpFlags: thread.dumpFlags ?? 0,
	dumpError: thread.dumpError ?? 0,
	exitStatus: thread.exitStatus ?? 0,
	createTime: thread.createTime ?? 0n,
	exitTime: thread.exitTime ?? 0n,
	kernelTime: thread.kernelTime ?? 0n,
	userTime: thread.userTime ?? 0n,
	startAddress: thread.startAddress ?? 0n,
	affinity: thread.affinity ?? 0n,
});

export const getMinidumpStreamTypeName = (streamType: number) =>
	MiniDumpStreamType[streamType] ?? `Unknown(${streamType})`;

export class MinidumpDebugInterface implements DebugInterface {
	readonly threads: Signal<DebugThread[]>;
	readonly modules: Signal<DebugModule[]>;
	readonly unloadedModules: Signal<DebugUnloadedModule[]>;
	readonly memoryRanges: Signal<DebugMemoryRange[]>;
	readonly currentThread: Signal<DebugThread | null>;
	readonly currentContext: Signal<Context | null>;

	readonly checksum: number;
	readonly timestamp: number;
	readonly flags: bigint;
	readonly streamCount: number;
	readonly streamTypes: number[];
	readonly systemInfo: MinidumpDebugSystemInfo | null;
	readonly miscInfo: MinidumpDebugMiscInfo | null;
	readonly exceptionInfo: MinidumpDebugExceptionInfo | null;

	private readonly source: MinidumpDebugSource;

	constructor(source: MinidumpDebugSource) {
		this.source = source;
		this.checksum = source.checksum;
		this.timestamp = source.timestamp;
		this.flags = source.flags;
		this.streamCount = source.streams.size;
		this.streamTypes = [...source.streams.keys()].sort(
			(left, right) => left - right,
		);
		this.systemInfo = source.systemInfo;
		this.miscInfo = source.miscInfo;

		const processorArchitecture = source.systemInfo?.processorArchitecture ?? 0;
		assert(processorArchitecture === 9, "Only x64 dumps are supported");

		const exceptionInfo = this.registerExceptionInfo(source.exceptionStream);
		this.exceptionInfo = exceptionInfo;

		const threads = source.associatedThreads.map((thread) => {
			const threadContext = this.registerThreadContext(thread);
			const exception =
				exceptionInfo && thread.threadId === exceptionInfo.threadId
					? this.buildThreadException(exceptionInfo)
					: null;
			return toDebugThread(thread, threadContext, exception);
		});

		const initialThread = this.selectCurrentThread(threads, exceptionInfo);
		this.threads = new Signal(threads);
		this.modules = new Signal(source.moduleList.map(toDebugModule));
		this.unloadedModules = new Signal(
			source.unloadedModuleList.map(toDebugUnloadedModule),
		);
		this.memoryRanges = new Signal(source.memoryRanges.map(toDebugMemoryRange));
		this.currentThread = new Signal(initialThread);
		this.currentContext = new Signal(
			initialThread?.exception?.context ?? initialThread?.context ?? null,
		);
	}

	selectThread(thread: DebugThread): void {
		this.currentThread.set(thread);
		this.currentContext.set(thread.exception?.context ?? thread.context);
	}

	async read(
		address: bigint,
		size: number,
		minSize?: number,
	): Promise<Uint8Array> {
		const requiredSize = minSize ?? size;
		if (size <= 0) {
			return new Uint8Array(0);
		}
		if (requiredSize < 0 || requiredSize > size) {
			throw new Error(
				`Invalid read size range: size=${size}, minSize=${requiredSize}`,
			);
		}

		const memoryBytes = this.source.readMemoryAt(address, size, requiredSize);
		if (memoryBytes) {
			return memoryBytes;
		}

		for (const mod of this.modules.state) {
			const modEnd = mod.address + BigInt(mod.size);
			if (address >= mod.address && address < modEnd) {
				const rva = Number(address - mod.address);
				const imageBytes = await readFromModuleImage(mod, rva, size);
				if (imageBytes && imageBytes.length >= requiredSize) {
					return imageBytes;
				}
				break;
			}
		}

		throw new Error(
			`Unable to read ${requiredSize}-${size} byte range at 0x${address.toString(16).toUpperCase()}`,
		);
	}

	private buildThreadException(
		info: MinidumpDebugExceptionInfo,
	): DebugThreadException {
		return {
			code: info.exceptionRecord.exceptionCode,
			flags: info.exceptionRecord.exceptionFlags,
			address: info.exceptionRecord.exceptionAddress,
			record: info.exceptionRecord.exceptionRecord,
			parameters: [...info.exceptionRecord.exceptionInformation],
			context: info.context,
		};
	}

	private registerThreadContext(
		thread: MinidumpAssociatedThread,
	): Context | null {
		if (!thread.threadContext) {
			return null;
		}

		const bytes = this.source.readLocationBytes(thread.threadContext);
		if (!bytes) return null;
		try {
			return new Context(bytes);
		} catch {
			return null;
		}
	}

	private registerExceptionInfo(
		exceptionStream: MinidumpExceptionStream | null,
	): MinidumpDebugExceptionInfo | null {
		if (!exceptionStream) {
			return null;
		}

		const bytes = this.source.readLocationBytes(exceptionStream.threadContext);
		let context: Context | null = null;
		if (bytes) {
			try {
				context = new Context(bytes);
			} catch {
				context = null;
			}
		}

		return {
			threadId: exceptionStream.threadId,
			exceptionRecord: {
				exceptionCode: exceptionStream.exceptionRecord.exceptionCode,
				exceptionFlags: exceptionStream.exceptionRecord.exceptionFlags,
				exceptionRecord: exceptionStream.exceptionRecord.exceptionRecord,
				exceptionAddress: exceptionStream.exceptionRecord.exceptionAddress,
				numberParameters: exceptionStream.exceptionRecord.numberParameters,
				exceptionInformation: [
					...exceptionStream.exceptionRecord.exceptionInformation,
				],
			},
			contextLocation: toMinidumpLocation(exceptionStream.threadContext),
			context,
		};
	}

	private selectCurrentThread(
		threads: DebugThread[],
		exceptionInfo: MinidumpDebugExceptionInfo | null,
	): DebugThread | null {
		if (exceptionInfo?.threadId) {
			const exceptionThread = threads.find(
				(t) => t.id === exceptionInfo.threadId,
			);
			if (exceptionThread) return exceptionThread;
		}

		return (
			threads.find((thread) => thread.context !== null) ?? threads[0] ?? null
		);
	}
}
