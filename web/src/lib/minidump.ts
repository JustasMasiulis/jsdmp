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
	platformId: number;
	platformName: string;
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
	miscRecord: MinidumpLocationDescriptor;
	reserved0: bigint;
	reserved1: bigint;
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

enum ThreadPriorityClass {
	NORMAL_PRIORITY_CLASS = 0x00000020,
	IDLE_PRIORITY_CLASS = 0x00000040,
	HIGH_PRIORITY_CLASS = 0x00000080,
	REALTIME_PRIORITY_CLASS = 0x00000100,
	BELOW_NORMAL_PRIORITY_CLASS = 0x4000,
	ABOVE_NORMAL_PRIORITY_CLASS = 0x8000,
}

export function priorityToString(
	priorityClass: number,
	priority: number,
): string {
	const base = [4, 6, 8, 10, 13, 24];
	const max = [15, 15, 15, 15, 15, 31];
	const min = [1, 1, 1, 1, 1, 16];

	let clasIdx: number;
	switch (priorityClass) {
		case ThreadPriorityClass.IDLE_PRIORITY_CLASS:
			clasIdx = 0;
			break;
		case ThreadPriorityClass.BELOW_NORMAL_PRIORITY_CLASS:
			clasIdx = 1;
			break;
		case ThreadPriorityClass.NORMAL_PRIORITY_CLASS:
			clasIdx = 2;
			break;
		case ThreadPriorityClass.ABOVE_NORMAL_PRIORITY_CLASS:
			clasIdx = 3;
			break;
		case ThreadPriorityClass.HIGH_PRIORITY_CLASS:
			clasIdx = 4;
			break;
		case ThreadPriorityClass.REALTIME_PRIORITY_CLASS:
			clasIdx = 5;
			break;
		default:
			return `UNK ${priorityClass} ${priority}`;
	}

	if (priority > 15 || priority < -15) {
		return `UNK ${priorityClass} ${priority}`;
	}

	let value = base[clasIdx] + priority;
	if (value > max[clasIdx]) {
		value = max[clasIdx];
	} else if (value < min[clasIdx]) {
		value = min[clasIdx];
	}

	return String(value);
}

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

export type MinidumpThreadInfoList = {
	sizeOfHeader: number;
	sizeOfEntry: number;
	numberOfEntries: number;
	entries: MinidumpThreadInfo[];
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
	threadList: MinidumpThread[] | null = null;
	threadInfoList: MinidumpThreadInfoList | null = null;
	associatedThreads: MinidumpAssociatedThread[] | null = null;
	exceptionStream: MinidumpExceptionStream | null = null;
	moduleList: MinidumpModule[] | null = null;

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
			}

			if (streamType === MiniDumpStreamType.MiscInfoStream) {
				this.miscInfo = this.parseMiscInfoStream(streamRva, streamSize);
			}

			if (streamType === MiniDumpStreamType.ThreadListStream) {
				this.threadList = this.parseThreadListStream(streamRva, streamSize);
			}

			if (streamType === MiniDumpStreamType.ThreadInfoListStream) {
				this.threadInfoList = this.parseThreadInfoListStream(
					streamRva,
					streamSize,
				);
			}

			if (streamType === MiniDumpStreamType.ExceptionStream) {
				this.exceptionStream = this.parseExceptionStream(streamRva, streamSize);
			}

			if (streamType === MiniDumpStreamType.ModuleListStream) {
				this.moduleList = this.parseModuleListStream(streamRva, streamSize);
			}
		}

		this.associatedThreads = this.associateThreadArrays();
	}

	private associateThreadArrays(): MinidumpAssociatedThread[] | null {
		const associated = new Map<number, MinidumpAssociatedThread>();

		for (const thread of this.threadList ?? []) {
			associated.set(thread.threadId, {
				threadId: thread.threadId,
				thread,
				threadInfo: null,
			});
		}

		for (const threadInfo of this.threadInfoList?.entries ?? []) {
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
				cvRecord: {
					dataSize: view.getUint32(offset + 76, true),
					rva: view.getUint32(offset + 80, true),
				},
				miscRecord: {
					dataSize: view.getUint32(offset + 84, true),
					rva: view.getUint32(offset + 88, true),
				},
				reserved0: view.getBigUint64(offset + 92, true),
				reserved1: view.getBigUint64(offset + 100, true),
			});
		}

		return modules;
	}

	private parseThreadInfoListStream(
		streamRva: number,
		streamSize: number,
	): MinidumpThreadInfoList {
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

		return {
			sizeOfHeader,
			sizeOfEntry,
			numberOfEntries,
			entries,
		};
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
			platformId,
			platformName: this.resolvePlatformId(platformId),
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

	private resolvePlatformId(platformId: number): string {
		switch (platformId) {
			case 0:
				return "Win32s";
			case 1:
				return "Win32 Windows";
			case 2:
				return "Win32 NT";
			case 3:
				return "Win32 CE";
			default:
				return `unknown (${platformId})`;
		}
	}
}
