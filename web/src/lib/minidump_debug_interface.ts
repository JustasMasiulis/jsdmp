import type {
	Address,
	DebugCodeViewInfo,
	DebugDataModel,
	DebugInterface,
	DebugLocation,
	DebugMemoryRange,
	DebugModule,
	DebugThread,
	DebugUnloadedModule,
} from "./debug_interface";
import {
	type MiniDump,
	MiniDumpStreamType,
	type MinidumpAssociatedThread,
	type MinidumpExceptionStream,
	type MinidumpMiscInfo,
	type MinidumpModule,
	type MinidumpSystemInfo,
	type MinidumpUnloadedModule,
} from "./minidump";

export type MinidumpDebugSystemInfo = MinidumpSystemInfo;
export type MinidumpDebugMiscInfo = MinidumpMiscInfo;

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
	contextLocation: DebugLocation;
	context: Address;
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

type SyntheticRange = {
	address: Address;
	bytes: Uint8Array;
};

const SYNTHETIC_CONTEXT_BASE = 1n << 64n;
const SYNTHETIC_CONTEXT_ALIGNMENT = 0x100n;

const EMPTY_LOCATION: DebugLocation = {
	size: 0,
	rva: 0,
};

const alignSyntheticSize = (size: number) => {
	const sizeBig = BigInt(Math.max(1, size));
	const remainder = sizeBig % SYNTHETIC_CONTEXT_ALIGNMENT;
	return remainder === 0n
		? sizeBig
		: sizeBig + (SYNTHETIC_CONTEXT_ALIGNMENT - remainder);
};

const toDebugLocation = (
	location?: { dataSize: number; rva: number } | null,
): DebugLocation =>
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
	codeViewInfo: DebugCodeViewInfo | null,
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
	codeViewRecord: toDebugLocation(module.cvRecord),
	codeViewInfo: module.codeViewInfo,
	miscRecord: toDebugLocation(module.miscRecord),
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
	context: Address,
): DebugThread => ({
	id: thread.threadId,
	suspendCount: thread.suspendCount ?? 0,
	priorityClass: thread.priorityClass ?? 0,
	priority: thread.priority ?? 0,
	teb: thread.teb ?? 0n,
	stack: {
		address: thread.stack?.startOfMemoryRange ?? 0n,
		location: toDebugLocation(thread.stack?.location),
	},
	context,
	contextLocation: toDebugLocation(thread.threadContext),
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
	readonly dm: DebugDataModel;
	readonly checksum: number;
	readonly timestamp: number;
	readonly flags: bigint;
	readonly streamCount: number;
	readonly streamTypes: number[];
	readonly systemInfo: MinidumpDebugSystemInfo | null;
	readonly miscInfo: MinidumpDebugMiscInfo | null;
	readonly exceptionInfo: MinidumpDebugExceptionInfo | null;

	private readonly source: MinidumpDebugSource;
	private readonly syntheticRanges: SyntheticRange[] = [];
	private nextSyntheticAddress = SYNTHETIC_CONTEXT_BASE;

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

		const threads = source.associatedThreads.map((thread) =>
			toDebugThread(thread, this.registerThreadContext(thread)),
		);
		const exceptionInfo = this.registerExceptionInfo(source.exceptionStream);

		this.exceptionInfo = exceptionInfo;
		this.dm = {
			threads,
			modules: source.moduleList.map(toDebugModule),
			unloadedModules: source.unloadedModuleList.map(toDebugUnloadedModule),
			memoryRanges: source.memoryRanges.map(toDebugMemoryRange),
			currentThreadId: this.selectCurrentThreadId(threads, exceptionInfo),
			currentContext: this.selectCurrentContext(threads, exceptionInfo),
		};
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

		const syntheticBytes = this.readSynthetic(address, size, requiredSize);
		if (syntheticBytes) {
			return syntheticBytes;
		}

		const memoryBytes = this.source.readMemoryAt(address, size, requiredSize);
		if (memoryBytes) {
			return memoryBytes;
		}

		throw new Error(
			`Unable to read ${requiredSize}-${size} byte range at 0x${address.toString(16).toUpperCase()}`,
		);
	}

	private registerThreadContext(thread: MinidumpAssociatedThread): Address {
		if (!thread.threadContext) {
			return 0n;
		}

		const bytes = this.source.readLocationBytes(thread.threadContext);
		return bytes ? this.registerSynthetic(bytes) : 0n;
	}

	private registerExceptionInfo(
		exceptionStream: MinidumpExceptionStream | null,
	): MinidumpDebugExceptionInfo | null {
		if (!exceptionStream) {
			return null;
		}

		const bytes = this.source.readLocationBytes(exceptionStream.threadContext);
		const context = bytes ? this.registerSynthetic(bytes) : 0n;

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
			contextLocation: toDebugLocation(exceptionStream.threadContext),
			context,
		};
	}

	private registerSynthetic(bytes: Uint8Array): Address {
		const address = this.nextSyntheticAddress;
		this.syntheticRanges.push({
			address,
			bytes,
		});
		this.nextSyntheticAddress += alignSyntheticSize(bytes.byteLength);
		return address;
	}

	private readSynthetic(
		address: Address,
		size: number,
		minSize: number,
	): Uint8Array | null {
		for (const range of this.syntheticRanges) {
			const rangeStart = range.address;
			const rangeEnd = range.address + BigInt(range.bytes.byteLength);
			if (address < rangeStart || address >= rangeEnd) {
				continue;
			}

			const available = rangeEnd - address;
			if (available < BigInt(minSize)) {
				return null;
			}

			const offset = Number(address - rangeStart);
			const byteCount = available < BigInt(size) ? Number(available) : size;
			return range.bytes.slice(offset, offset + byteCount);
		}

		return null;
	}

	private selectCurrentThreadId(
		threads: DebugThread[],
		exceptionInfo: MinidumpDebugExceptionInfo | null,
	) {
		if (exceptionInfo?.threadId) {
			return exceptionInfo.threadId;
		}

		return (
			threads.find((thread) => thread.context !== 0n)?.id ?? threads[0]?.id ?? 0
		);
	}

	private selectCurrentContext(
		threads: DebugThread[],
		exceptionInfo: MinidumpDebugExceptionInfo | null,
	) {
		if (exceptionInfo?.context) {
			return exceptionInfo.context;
		}

		const currentThread = threads.find(
			(thread) =>
				thread.id === this.selectCurrentThreadId(threads, exceptionInfo),
		);
		return currentThread?.context ? 0n : 0n;
	}
}
