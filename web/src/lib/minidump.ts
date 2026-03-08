export enum MiniDumpStreamType {
	UnusedStream = 0,
	ReservedStream0 = 1,
	ReservedStream1 = 2,
	ThreadListStream = 3,
	ModuleListStream = 4,
	MemoryListStream = 5,
	ExceptionStream = 6,
	SystemInfoStream = 7,
	ThreadExListStream = 8,
	Memory64ListStream = 9,
	CommentStreamA = 10,
	CommentStreamW = 11,
	HandleDataStream = 12,
	FunctionTableStream = 13,
	UnloadedModuleListStream = 14,
	MiscInfoStream = 15,
	MemoryInfoListStream = 16,
	ThreadInfoListStream = 17,
	HandleOperationListStream = 18,
	TokenStream = 19,
	JavaScriptDataStream = 20,
	SystemMemoryInfoStream = 21,
	ProcessVmCountersStream = 22,
	IptTraceStream = 23,
	ThreadNamesStream = 24,
	ceStreamNull = 0x8000,
	ceStreamSystemInfo = 0x8001,
	ceStreamException = 0x8002,
	ceStreamModuleList = 0x8003,
	ceStreamProcessList = 0x8004,
	ceStreamThreadList = 0x8005,
	ceStreamThreadContextList = 0x8006,
	ceStreamThreadCallStackList = 0x8007,
	ceStreamMemoryVirtualList = 0x8008,
	ceStreamMemoryPhysicalList = 0x8009,
	ceStreamBucketParameters = 0x800a,
	ceStreamProcessModuleMap = 0x800b,
	ceStreamDiagnosisList = 0x800c,
	LastReservedStream = 0xffff,
}

enum MinidumpMiscInfoFlags1 {
	ProcessId = 0x00000001,
	ProcessTimes = 0x00000002,
	ProcessorPowerInfo = 0x00000004,
}

export type MinidumpSystemInfo = {
	processorArchitecture: number;
	processorArchitectureName: string;
	processorLevel: number;
	processorRevision: number;
	numberOfProcessors: number;
	productType: number;
	majorVersion: number;
	minorVersion: number;
	buildNumber: number;
	csdVersion: string;
	suiteMask: number;
	cpu:
		| {
				type: "x86";
				vendorId: string;
				versionInformation: number;
				featureInformation: number;
				amdExtendedCpuFeatures: number;
		  }
		| {
				type: "other";
				processorFeatures: [bigint, bigint];
		  };
};

export type MinidumpMiscInfo = {
	sizeOfInfo: number;
	flags1: number;
	processId: number | null;
	processCreateTime: number | null;
	processUserTime: number | null;
	processKernelTime: number | null;
	processorMaxMhz: number | null;
	processorCurrentMhz: number | null;
	processorMhzLimit: number | null;
	processorMaxIdleState: number | null;
	processorCurrentIdleState: number | null;
};

export type MinidumpLocationDescriptor = {
	dataSize: number;
	rva: number;
};

export type MinidumpMemory64Range = {
	address: bigint;
	dataSize: bigint;
	dataRva: bigint;
};

export type MinidumpCodeViewInfo =
	| {
			format: "RSDS";
			guid: string;
			age: number;
			pdbFileName: string;
	  }
	| {
			format: "NB10";
			offset: number;
			timestamp: number;
			age: number;
			pdbFileName: string;
	  }
	| {
			format: "unknown";
			signature: string;
			rawSignature: number;
	  }
	| {
			format: "invalid";
			error: string;
	  };

export type MinidumpVsFixedFileInfo = {
	signature: number;
	structVersion: number;
	fileVersionMs: number;
	fileVersionLs: number;
	productVersionMs: number;
	productVersionLs: number;
	fileFlagsMask: number;
	fileFlags: number;
	fileOs: number;
	fileType: number;
	fileSubtype: number;
	fileDateMs: number;
	fileDateLs: number;
};

export type MinidumpModule = {
	baseOfImage: bigint;
	sizeOfImage: number;
	checkSum: number;
	timeDateStamp: number;
	moduleNameRva: number;
	moduleName: string;
	versionInfo: MinidumpVsFixedFileInfo;
	cvRecord: MinidumpLocationDescriptor;
	codeViewInfo: MinidumpCodeViewInfo | null;
	miscRecord: MinidumpLocationDescriptor;
	reserved0: bigint;
	reserved1: bigint;
};

export type MinidumpUnloadedModule = {
	baseOfImage: bigint;
	sizeOfImage: number;
	checkSum: number;
	timeDateStamp: number;
	moduleNameRva: number;
	moduleName: string;
};

export type MinidumpThread = {
	threadId: number;
	suspendCount: number;
	priorityClass: number;
	priority: number;
	teb: bigint;
	stack: {
		startOfMemoryRange: bigint;
		location: MinidumpLocationDescriptor;
	};
	threadContext: MinidumpLocationDescriptor;
};

export type MinidumpThreadInfo = {
	threadId: number;
	dumpFlags: number;
	dumpError: number;
	exitStatus: number;
	createTime: bigint;
	exitTime: bigint;
	kernelTime: bigint;
	userTime: bigint;
	startAddress: bigint;
	affinity: bigint;
};

export type MinidumpAssociatedThread = {
	threadId: number;
	thread: MinidumpThread | null;
	threadInfo: MinidumpThreadInfo | null;
};

export type MinidumpException = {
	exceptionCode: number;
	exceptionFlags: number;
	exceptionRecord: bigint;
	exceptionAddress: bigint;
	numberParameters: number;
	exceptionInformation: bigint[];
};

export type MinidumpExceptionStream = {
	threadId: number;
	exceptionRecord: MinidumpException;
	threadContext: MinidumpLocationDescriptor;
};

export class MiniDump {
	private _data: DataView;
	checksum: number;
	timestamp: number;
	flags: bigint;
	streams: Map<number, DataView> = new Map();
	systemInfo: MinidumpSystemInfo | null = null;
	miscInfo: MinidumpMiscInfo | null = null;
	associatedThreads: MinidumpAssociatedThread[] | null = null;
	exceptionStream: MinidumpExceptionStream | null = null;
	moduleList: MinidumpModule[] | null = null;
	unloadedModuleList: MinidumpUnloadedModule[] | null = null;
	memoryRanges: MinidumpMemory64Range[] = [];

	constructor(data: ArrayBuffer) {
		this._data = new DataView(data);

		const signature = this._data.getUint32(0, true);
		if (signature !== 1347241037) {
			throw new Error(`Invalid minidump signature: ${signature}`);
		}

		const version = this._data.getUint16(4, true);
		if (version !== 42899) {
			throw new Error(`Invalid minidump version: ${version}`);
		}

		this.checksum = this._data.getUint32(16, true);
		this.timestamp = this._data.getUint32(20, true);
		this.flags = this._data.getBigUint64(24, true);

		const numStreams = this._data.getUint32(8, true);
		const streamOffset = this._data.getUint32(12, true);

		let threadList: MinidumpThread[] = [];
		let threadInfoList: MinidumpThreadInfo[] = [];

		for (let i = 0; i < numStreams; i++) {
			const offset = streamOffset + i * 12;
			const streamType = this._data.getUint32(offset, true);
			const streamSize = this._data.getUint32(offset + 4, true);
			const streamRva = this._data.getUint32(offset + 8, true);

			if (streamType === 0) continue;

			if (this.streams.has(streamType)) {
				throw new Error(`Stream type ${streamType} already exists`);
			}

			const streamData = this._data.buffer.slice(
				streamRva,
				streamRva + streamSize,
			);
			this.streams.set(streamType, new DataView(streamData));

			if (streamType === MiniDumpStreamType.SystemInfoStream) {
				this.systemInfo = this.parseSystemInfoStream(streamRva, streamSize);
			} else if (streamType === MiniDumpStreamType.MiscInfoStream) {
				this.miscInfo = this.parseMiscInfoStream(streamRva, streamSize);
			} else if (streamType === MiniDumpStreamType.ThreadListStream) {
				threadList = this.parseThreadListStream(streamRva, streamSize);
			} else if (streamType === MiniDumpStreamType.ThreadInfoListStream) {
				threadInfoList = this.parseThreadInfoListStream(streamRva, streamSize);
			} else if (streamType === MiniDumpStreamType.MemoryListStream) {
				this.parseMemoryListStream(streamRva, streamSize);
			} else if (streamType === MiniDumpStreamType.Memory64ListStream) {
				this.parseMemory64ListStream(streamRva, streamSize);
			} else if (streamType === MiniDumpStreamType.ExceptionStream) {
				this.exceptionStream = this.parseExceptionStream(streamRva, streamSize);
			} else if (streamType === MiniDumpStreamType.ModuleListStream) {
				this.moduleList = this.parseModuleListStream(streamRva, streamSize);
			} else if (streamType === MiniDumpStreamType.UnloadedModuleListStream) {
				this.unloadedModuleList = this.parseUnloadedModuleListStream(
					streamRva,
					streamSize,
				);
			}
		}

		this.memoryRanges = this.memoryRanges.sort((a, b) => {
			if (a.address < b.address) {
				return -1;
			}
			if (a.address > b.address) {
				return 1;
			}
			return 0;
		});

		this.associatedThreads = this.associateThreadArrays(
			threadList,
			threadInfoList,
		);
	}

	readLocationBytes(location: MinidumpLocationDescriptor): Uint8Array | null {
		if (
			location.dataSize <= 0 ||
			location.rva <= 0 ||
			location.rva + location.dataSize > this._data.byteLength
		) {
			return null;
		}

		return new Uint8Array(
			this._data.buffer.slice(location.rva, location.rva + location.dataSize),
		);
	}

	findMemoryRange(address: bigint): MinidumpMemory64Range | null {
		for (const range of this.memoryRanges) {
			const start = range.address;
			const endExclusive = start + range.dataSize;
			if (address >= start && address < endExclusive) {
				return range;
			}
		}

		return null;
	}

	readMemoryAt(address: bigint, size: number): Uint8Array | null {
		if (size <= 0) {
			return null;
		}

		const range = this.findMemoryRange(address);
		if (!range) {
			return null;
		}

		const offset = address - range.address;
		const available = range.dataSize - offset;
		const requested = BigInt(size);
		if (available < requested) {
			return null;
		}

		const start = range.dataRva + offset;
		const end = start + requested;
		const maxByteLength = BigInt(this._data.byteLength);
		if (start < 0n || end > maxByteLength) {
			return null;
		}

		const maxSafeInteger = BigInt(Number.MAX_SAFE_INTEGER);
		if (start > maxSafeInteger || end > maxSafeInteger) {
			return null;
		}

		return new Uint8Array(this._data.buffer.slice(Number(start), Number(end)));
	}

	private associateThreadArrays(
		threadList: MinidumpThread[],
		threadInfoList: MinidumpThreadInfo[],
	): MinidumpAssociatedThread[] | null {
		const associated = new Map<number, MinidumpAssociatedThread>();

		for (const thread of threadList) {
			associated.set(thread.threadId, {
				threadId: thread.threadId,
				thread,
				threadInfo: null,
			});
		}

		for (const threadInfo of threadInfoList) {
			const existing = associated.get(threadInfo.threadId);
			if (existing) {
				existing.threadInfo = threadInfo;
				continue;
			}

			associated.set(threadInfo.threadId, {
				threadId: threadInfo.threadId,
				thread: null,
				threadInfo,
			});
		}

		return associated.size > 0 ? [...associated.values()] : null;
	}

	private parseThreadListStream(
		streamRva: number,
		streamSize: number,
	): MinidumpThread[] {
		if (streamSize < 4) {
			throw new Error(`ThreadListStream is too small: ${streamSize} bytes`);
		}

		const view = new DataView(
			this._data.buffer,
			this._data.byteOffset + streamRva,
			streamSize,
		);
		const numberOfThreads = view.getUint32(0, true);
		const entrySize = 48;
		const requiredSize = 4 + numberOfThreads * entrySize;

		if (requiredSize > streamSize) {
			throw new Error(
				`ThreadListStream truncated: need ${requiredSize} bytes, got ${streamSize}`,
			);
		}

		const threads: MinidumpThread[] = [];
		for (let i = 0; i < numberOfThreads; i++) {
			const offset = 4 + i * entrySize;
			threads.push({
				threadId: view.getUint32(offset, true),
				suspendCount: view.getUint32(offset + 4, true),
				priorityClass: view.getUint32(offset + 8, true),
				priority: view.getInt32(offset + 12, true),
				teb: view.getBigUint64(offset + 16, true),
				stack: {
					startOfMemoryRange: view.getBigUint64(offset + 24, true),
					location: {
						dataSize: view.getUint32(offset + 32, true),
						rva: view.getUint32(offset + 36, true),
					},
				},
				threadContext: {
					dataSize: view.getUint32(offset + 40, true),
					rva: view.getUint32(offset + 44, true),
				},
			});
		}

		return threads;
	}

	private parseMemoryListStream(streamRva: number, streamSize: number) {
		if (streamSize < 4) {
			throw new Error(`MemoryListStream is too small: ${streamSize} bytes`);
		}

		const view = new DataView(
			this._data.buffer,
			this._data.byteOffset + streamRva,
			streamSize,
		);
		const numberOfMemoryRanges = view.getUint32(0, true);
		const entrySize = 16;
		const requiredSize = 4 + numberOfMemoryRanges * entrySize;

		if (requiredSize > streamSize) {
			throw new Error(
				`MemoryListStream truncated: need ${requiredSize} bytes, got ${streamSize}`,
			);
		}

		for (let i = 0; i < numberOfMemoryRanges; i++) {
			const offset = 4 + i * entrySize;
			this.memoryRanges.push({
				address: view.getBigUint64(offset, true),
				dataSize: BigInt(view.getUint32(offset + 8, true)),
				dataRva: BigInt(view.getUint32(offset + 12, true)),
			});
		}
	}

	private parseMemory64ListStream(streamRva: number, streamSize: number) {
		if (streamSize < 16) {
			throw new Error(`Memory64ListStream is too small: ${streamSize} bytes`);
		}

		const view = new DataView(
			this._data.buffer,
			this._data.byteOffset + streamRva,
			streamSize,
		);

		const numberOfMemoryRangesBig = view.getBigUint64(0, true);
		const baseRva = view.getBigUint64(8, true);
		const entrySize = 16n;
		const requiredSize = 16n + numberOfMemoryRangesBig * entrySize;
		if (requiredSize > BigInt(streamSize)) {
			throw new Error(
				`Memory64ListStream truncated: need ${requiredSize} bytes, got ${streamSize}`,
			);
		}

		const maxSafeInteger = BigInt(Number.MAX_SAFE_INTEGER);
		if (numberOfMemoryRangesBig > maxSafeInteger) {
			throw new Error(
				`Memory64ListStream range count is too large: ${numberOfMemoryRangesBig}`,
			);
		}

		const numberOfMemoryRanges = Number(numberOfMemoryRangesBig);
		let currentRva = baseRva;
		const maxByteLength = BigInt(this._data.byteLength);

		for (let i = 0; i < numberOfMemoryRanges; i++) {
			const offset = 16 + i * 16;
			const startOfMemoryRange = view.getBigUint64(offset, true);
			const dataSize = view.getBigUint64(offset + 8, true);
			const nextRva = currentRva + dataSize;
			if (nextRva > maxByteLength) {
				throw new Error(
					`Memory64ListStream data exceeds file bounds at range index ${i}`,
				);
			}

			this.memoryRanges.push({
				address: startOfMemoryRange,
				dataSize: dataSize,
				dataRva: currentRva,
			});

			currentRva = nextRva;
		}
	}

	private parseModuleListStream(
		streamRva: number,
		streamSize: number,
	): MinidumpModule[] {
		if (streamSize < 4) {
			throw new Error(`ModuleListStream is too small: ${streamSize} bytes`);
		}

		const view = new DataView(
			this._data.buffer,
			this._data.byteOffset + streamRva,
			streamSize,
		);
		const numberOfModules = view.getUint32(0, true);
		const entrySize = 108;
		const requiredSize = 4 + numberOfModules * entrySize;

		if (requiredSize > streamSize) {
			throw new Error(
				`ModuleListStream truncated: need ${requiredSize} bytes, got ${streamSize}`,
			);
		}

		const modules: MinidumpModule[] = [];
		for (let i = 0; i < numberOfModules; i++) {
			const offset = 4 + i * entrySize;
			const moduleNameRva = view.getUint32(offset + 20, true);
			const cvRecord = {
				dataSize: view.getUint32(offset + 76, true),
				rva: view.getUint32(offset + 80, true),
			};
			const miscRecord = {
				dataSize: view.getUint32(offset + 84, true),
				rva: view.getUint32(offset + 88, true),
			};

			modules.push({
				baseOfImage: view.getBigUint64(offset, true),
				sizeOfImage: view.getUint32(offset + 8, true),
				checkSum: view.getUint32(offset + 12, true),
				timeDateStamp: view.getUint32(offset + 16, true),
				moduleNameRva,
				moduleName: moduleNameRva ? this.readMinidumpString(moduleNameRva) : "",
				versionInfo: {
					signature: view.getUint32(offset + 24, true),
					structVersion: view.getUint32(offset + 28, true),
					fileVersionMs: view.getUint32(offset + 32, true),
					fileVersionLs: view.getUint32(offset + 36, true),
					productVersionMs: view.getUint32(offset + 40, true),
					productVersionLs: view.getUint32(offset + 44, true),
					fileFlagsMask: view.getUint32(offset + 48, true),
					fileFlags: view.getUint32(offset + 52, true),
					fileOs: view.getUint32(offset + 56, true),
					fileType: view.getUint32(offset + 60, true),
					fileSubtype: view.getUint32(offset + 64, true),
					fileDateMs: view.getUint32(offset + 68, true),
					fileDateLs: view.getUint32(offset + 72, true),
				},
				cvRecord,
				codeViewInfo: this.parseCodeViewInfo(cvRecord),
				miscRecord,
				reserved0: view.getBigUint64(offset + 92, true),
				reserved1: view.getBigUint64(offset + 100, true),
			});
		}

		return modules;
	}

	private parseUnloadedModuleListStream(
		streamRva: number,
		streamSize: number,
	): MinidumpUnloadedModule[] {
		if (streamSize < 12) {
			throw new Error(
				`UnloadedModuleListStream is too small: ${streamSize} bytes`,
			);
		}

		const view = new DataView(
			this._data.buffer,
			this._data.byteOffset + streamRva,
			streamSize,
		);

		const sizeOfHeader = view.getUint32(0, true);
		const sizeOfEntry = view.getUint32(4, true);
		const numberOfEntries = view.getUint32(8, true);

		if (sizeOfHeader < 12 || sizeOfHeader > streamSize) {
			throw new Error(
				`Invalid UnloadedModuleList header size: ${sizeOfHeader}`,
			);
		}

		if (sizeOfEntry < 24) {
			throw new Error(
				`Unsupported UnloadedModuleList entry size: ${sizeOfEntry}`,
			);
		}

		const requiredSize = sizeOfHeader + numberOfEntries * sizeOfEntry;
		if (requiredSize > streamSize) {
			throw new Error(
				`UnloadedModuleListStream truncated: need ${requiredSize} bytes, got ${streamSize}`,
			);
		}

		const unloadedModules: MinidumpUnloadedModule[] = [];
		for (let i = 0; i < numberOfEntries; i++) {
			const offset = sizeOfHeader + i * sizeOfEntry;
			const moduleNameRva = view.getUint32(offset + 20, true);
			unloadedModules.push({
				baseOfImage: view.getBigUint64(offset, true),
				sizeOfImage: view.getUint32(offset + 8, true),
				checkSum: view.getUint32(offset + 12, true),
				timeDateStamp: view.getUint32(offset + 16, true),
				moduleNameRva,
				moduleName: moduleNameRva ? this.readMinidumpString(moduleNameRva) : "",
			});
		}

		return unloadedModules;
	}

	private parseThreadInfoListStream(
		streamRva: number,
		streamSize: number,
	): MinidumpThreadInfo[] {
		if (streamSize < 12) {
			throw new Error(`ThreadInfoListStream is too small: ${streamSize} bytes`);
		}

		const view = new DataView(
			this._data.buffer,
			this._data.byteOffset + streamRva,
			streamSize,
		);

		const sizeOfHeader = view.getUint32(0, true);
		const sizeOfEntry = view.getUint32(4, true);
		const numberOfEntries = view.getUint32(8, true);

		if (sizeOfHeader < 12 || sizeOfHeader > streamSize) {
			throw new Error(`Invalid ThreadInfoList header size: ${sizeOfHeader}`);
		}

		if (sizeOfEntry < 64) {
			throw new Error(`Unsupported ThreadInfoList entry size: ${sizeOfEntry}`);
		}

		const requiredSize = sizeOfHeader + numberOfEntries * sizeOfEntry;
		if (requiredSize > streamSize) {
			throw new Error(
				`ThreadInfoListStream truncated: need ${requiredSize} bytes, got ${streamSize}`,
			);
		}

		const entries: MinidumpThreadInfo[] = [];
		for (let i = 0; i < numberOfEntries; i++) {
			const offset = sizeOfHeader + i * sizeOfEntry;
			entries.push({
				threadId: view.getUint32(offset, true),
				dumpFlags: view.getUint32(offset + 4, true),
				dumpError: view.getUint32(offset + 8, true),
				exitStatus: view.getUint32(offset + 12, true),
				createTime: view.getBigUint64(offset + 16, true),
				exitTime: view.getBigUint64(offset + 24, true),
				kernelTime: view.getBigUint64(offset + 32, true),
				userTime: view.getBigUint64(offset + 40, true),
				startAddress: view.getBigUint64(offset + 48, true),
				affinity: view.getBigUint64(offset + 56, true),
			});
		}

		return entries;
	}

	private parseExceptionStream(
		streamRva: number,
		streamSize: number,
	): MinidumpExceptionStream {
		const exceptionRecordSize = 152;
		const minExceptionStreamSize = 8 + exceptionRecordSize + 8;
		if (streamSize < minExceptionStreamSize) {
			throw new Error(`ExceptionStream is too small: ${streamSize} bytes`);
		}

		const view = new DataView(
			this._data.buffer,
			this._data.byteOffset + streamRva,
			streamSize,
		);

		const threadId = view.getUint32(0, true);
		const exceptionOffset = 8;
		const exceptionCode = view.getUint32(exceptionOffset, true);
		const exceptionFlags = view.getUint32(exceptionOffset + 4, true);
		const exceptionRecord = view.getBigUint64(exceptionOffset + 8, true);
		const exceptionAddress = view.getBigUint64(exceptionOffset + 16, true);
		const numberParameters = view.getUint32(exceptionOffset + 24, true);

		const maxExceptionParameters = 15;
		if (numberParameters > maxExceptionParameters) {
			throw new Error(
				`ExceptionStream numberParameters exceeds ${maxExceptionParameters}: ${numberParameters}`,
			);
		}

		const exceptionInformation: bigint[] = [];
		const informationOffset = exceptionOffset + 32;
		for (let i = 0; i < numberParameters; i++) {
			exceptionInformation.push(
				view.getBigUint64(informationOffset + i * 8, true),
			);
		}

		const threadContextOffset = exceptionOffset + exceptionRecordSize;
		return {
			threadId,
			exceptionRecord: {
				exceptionCode,
				exceptionFlags,
				exceptionRecord,
				exceptionAddress,
				numberParameters,
				exceptionInformation,
			},
			threadContext: {
				dataSize: view.getUint32(threadContextOffset, true),
				rva: view.getUint32(threadContextOffset + 4, true),
			},
		};
	}

	private parseMiscInfoStream(
		streamRva: number,
		streamSize: number,
	): MinidumpMiscInfo {
		if (streamSize < 8) {
			throw new Error(`MiscInfoStream is too small: ${streamSize} bytes`);
		}

		const view = new DataView(
			this._data.buffer,
			this._data.byteOffset + streamRva,
			streamSize,
		);
		const sizeOfInfo = view.getUint32(0, true);
		if (sizeOfInfo < 8) {
			throw new Error(`Invalid MINIDUMP_MISC_INFO size: ${sizeOfInfo}`);
		}

		const readableSize = Math.min(streamSize, sizeOfInfo);
		const flags1 = view.getUint32(4, true);
		const hasProcessId = (flags1 & MinidumpMiscInfoFlags1.ProcessId) !== 0;
		const hasProcessTimes =
			(flags1 & MinidumpMiscInfoFlags1.ProcessTimes) !== 0;
		const hasProcessorPower =
			(flags1 & MinidumpMiscInfoFlags1.ProcessorPowerInfo) !== 0;

		return {
			sizeOfInfo,
			flags1,
			processId:
				hasProcessId && readableSize >= 12 ? view.getUint32(8, true) : null,
			processCreateTime:
				hasProcessTimes && readableSize >= 16 ? view.getUint32(12, true) : null,
			processUserTime:
				hasProcessTimes && readableSize >= 20 ? view.getUint32(16, true) : null,
			processKernelTime:
				hasProcessTimes && readableSize >= 24 ? view.getUint32(20, true) : null,
			processorMaxMhz:
				hasProcessorPower && readableSize >= 28
					? view.getUint32(24, true)
					: null,
			processorCurrentMhz:
				hasProcessorPower && readableSize >= 32
					? view.getUint32(28, true)
					: null,
			processorMhzLimit:
				hasProcessorPower && readableSize >= 36
					? view.getUint32(32, true)
					: null,
			processorMaxIdleState:
				hasProcessorPower && readableSize >= 40
					? view.getUint32(36, true)
					: null,
			processorCurrentIdleState:
				hasProcessorPower && readableSize >= 44
					? view.getUint32(40, true)
					: null,
		};
	}

	private parseSystemInfoStream(
		streamRva: number,
		streamSize: number,
	): MinidumpSystemInfo {
		if (streamSize < 56) {
			throw new Error(`SystemInfoStream is too small: ${streamSize} bytes`);
		}

		const view = new DataView(
			this._data.buffer,
			this._data.byteOffset + streamRva,
			streamSize,
		);
		const processorArchitecture = view.getUint16(0, true);
		const processorLevel = view.getUint16(2, true);
		const processorRevision = view.getUint16(4, true);
		const numberOfProcessors = view.getUint8(6);
		const productType = view.getUint8(7);
		const majorVersion = view.getUint32(8, true);
		const minorVersion = view.getUint32(12, true);
		const buildNumber = view.getUint32(16, true);
		const platformId = view.getUint32(20, true);
		const csdVersionRva = view.getUint32(24, true);
		const suiteMask = view.getUint16(28, true);

		if (platformId !== 2) {
			throw new Error(`Unsupported platform ID: ${platformId}`);
		}

		const isIntel = processorArchitecture === 0;
		const cpu = isIntel
			? {
					type: "x86" as const,
					vendorId: this.readFixedAscii(view, 32, 12),
					versionInformation: view.getUint32(44, true),
					featureInformation: view.getUint32(48, true),
					amdExtendedCpuFeatures: view.getUint32(52, true),
				}
			: {
					type: "other" as const,
					processorFeatures: [
						view.getBigUint64(32, true),
						view.getBigUint64(40, true),
					] as [bigint, bigint],
				};

		return {
			processorArchitecture,
			processorArchitectureName: this.resolveProcessorArchitecture(
				processorArchitecture,
			),
			processorLevel,
			processorRevision,
			numberOfProcessors,
			productType,
			majorVersion,
			minorVersion,
			buildNumber,
			csdVersion: csdVersionRva ? this.readMinidumpString(csdVersionRva) : "",
			suiteMask,
			cpu,
		};
	}

	private readFixedAscii(
		view: DataView,
		offset: number,
		length: number,
	): string {
		const bytes = new Uint8Array(view.buffer, view.byteOffset + offset, length);
		let value = "";
		for (let i = 0; i < bytes.length; i++) {
			if (bytes[i] === 0) break;
			value += String.fromCharCode(bytes[i]);
		}
		return value;
	}

	private parseCodeViewInfo(
		cvRecord: MinidumpLocationDescriptor,
	): MinidumpCodeViewInfo | null {
		const { dataSize, rva } = cvRecord;
		if (dataSize === 0 && rva === 0) {
			return null;
		}

		if (dataSize === 0 || rva === 0) {
			return {
				format: "invalid",
				error: `invalid location (size=${dataSize}, rva=${rva})`,
			};
		}

		const end = rva + dataSize;
		if (end < rva || end > this._data.byteLength) {
			return {
				format: "invalid",
				error: `out of bounds (size=${dataSize}, rva=${rva})`,
			};
		}

		if (dataSize < 4) {
			return {
				format: "invalid",
				error: `record too small: ${dataSize} bytes`,
			};
		}

		const view = new DataView(
			this._data.buffer,
			this._data.byteOffset + rva,
			dataSize,
		);
		const rawSignature = view.getUint32(0, true);
		const signature = this.fourCcFromUint32(rawSignature);

		if (signature === "RSDS") {
			if (dataSize < 24) {
				return {
					format: "invalid",
					error: `RSDS record too small: ${dataSize} bytes`,
				};
			}

			return {
				format: "RSDS",
				guid: this.readCodeViewGuid(view, 4),
				age: view.getUint32(20, true),
				pdbFileName: this.readNullTerminatedAscii(view, 24),
			};
		}

		if (signature === "NB10") {
			if (dataSize < 16) {
				return {
					format: "invalid",
					error: `NB10 record too small: ${dataSize} bytes`,
				};
			}

			return {
				format: "NB10",
				offset: view.getUint32(4, true),
				timestamp: view.getUint32(8, true),
				age: view.getUint32(12, true),
				pdbFileName: this.readNullTerminatedAscii(view, 16),
			};
		}

		return {
			format: "unknown",
			signature,
			rawSignature,
		};
	}

	private fourCcFromUint32(value: number): string {
		let text = "";
		for (let i = 0; i < 4; i++) {
			const code = (value >>> (i * 8)) & 0xff;
			text += code >= 32 && code <= 126 ? String.fromCharCode(code) : "\uFFFD";
		}
		return text;
	}

	private readCodeViewGuid(view: DataView, offset: number): string {
		const data1 = view.getUint32(offset, true);
		const data2 = view.getUint16(offset + 4, true);
		const data3 = view.getUint16(offset + 6, true);
		const data4_0 = view.getUint8(offset + 8);
		const data4_1 = view.getUint8(offset + 9);

		let suffix = "";
		for (let i = 10; i < 16; i++) {
			suffix += this.formatHex(view.getUint8(offset + i), 2);
		}

		return `${this.formatHex(data1, 8)}-${this.formatHex(data2, 4)}-${this.formatHex(data3, 4)}-${this.formatHex(data4_0, 2)}${this.formatHex(data4_1, 2)}-${suffix}`;
	}

	private readNullTerminatedAscii(view: DataView, offset: number): string {
		if (offset >= view.byteLength) {
			return "";
		}

		const bytes = new Uint8Array(
			view.buffer,
			view.byteOffset + offset,
			view.byteLength - offset,
		);

		let value = "";
		for (let i = 0; i < bytes.length && bytes[i] !== 0; i++) {
			value += String.fromCharCode(bytes[i]);
		}
		return value;
	}

	private formatHex(value: number, width: number): string {
		return value.toString(16).toUpperCase().padStart(width, "0");
	}

	private readMinidumpString(rva: number): string {
		if (rva + 4 > this._data.byteLength) {
			throw new Error(`String RVA out of bounds: ${rva}`);
		}

		const length = this._data.getUint32(rva, true);
		if (rva + 4 + length > this._data.byteLength) {
			throw new Error(`String length out of bounds at RVA ${rva}: ${length}`);
		}

		const bytes = new Uint8Array(
			this._data.buffer,
			this._data.byteOffset + rva + 4,
			length,
		);
		return new TextDecoder("utf-16le").decode(bytes);
	}

	private resolveProcessorArchitecture(architecture: number): string {
		switch (architecture) {
			case 0:
				return "x86";
			case 5:
				return "ARM";
			case 6:
				return "Itanium";
			case 9:
				return "x64";
			case 12:
				return "ARM64";
			default:
				return `unknown (${architecture})`;
		}
	}
}
