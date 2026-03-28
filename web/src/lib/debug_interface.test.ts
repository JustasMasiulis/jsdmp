import { describe, expect, it } from "bun:test";
import { CONTEXT_AMD64, resolveDumpContext } from "./context";
import {
	MinidumpDebugInterface,
	type MinidumpDebugSource,
} from "./minidump_debug_interface";
import type {
	MinidumpAssociatedThread,
	MinidumpExceptionStream,
	MinidumpLocationDescriptor,
	MinidumpMemory64Range,
	MinidumpMiscInfo,
	MinidumpModule,
	MinidumpSystemInfo,
	MinidumpUnloadedModule,
} from "./minidump";

type MemorySegment = {
	start: bigint;
	bytes: Uint8Array;
};

type SourceOptions = {
	associatedThreads?: MinidumpAssociatedThread[];
	exceptionStream?: MinidumpExceptionStream | null;
	locationBytes?: Array<[number, Uint8Array]>;
	memorySegments?: MemorySegment[];
	moduleList?: MinidumpModule[];
	unloadedModuleList?: MinidumpUnloadedModule[];
	systemInfo?: MinidumpSystemInfo | null;
	miscInfo?: MinidumpMiscInfo | null;
};

const makeContextBytes = (ip: bigint, sp = 0x8000n) => {
	const bytes = new Uint8Array(0x100);
	const view = new DataView(bytes.buffer);
	view.setUint32(0x30, CONTEXT_AMD64, true);
	view.setUint32(0x44, CONTEXT_AMD64, true);
	view.setBigUint64(0x98, sp, true);
	view.setBigUint64(0xf8, ip, true);
	return bytes;
};

const makeLocation = (rva: number, dataSize = 0x100): MinidumpLocationDescriptor => ({
	dataSize,
	rva,
});

const makeThread = (
	threadId: number,
	threadContext: MinidumpLocationDescriptor,
): MinidumpAssociatedThread => ({
	threadId,
	suspendCount: 0,
	priorityClass: 0,
	priority: 0,
	teb: 0x70000000n + BigInt(threadId),
	stack: {
		startOfMemoryRange: 0x60000000n,
		location: makeLocation(0x3000, 0x40),
	},
	threadContext,
	dumpFlags: 0,
	dumpError: 0,
	exitStatus: 0,
	createTime: 1n,
	exitTime: 0n,
	kernelTime: 0n,
	userTime: 0n,
	startAddress: 0x401000n,
	affinity: 1n,
});

const findSegment = (memorySegments: MemorySegment[], address: bigint) =>
	memorySegments.find((segment) => {
		const endExclusive = segment.start + BigInt(segment.bytes.byteLength);
		return address >= segment.start && address < endExclusive;
	});

const buildSource = (options: SourceOptions = {}): MinidumpDebugSource => {
	const locationBytes = new Map(options.locationBytes ?? []);
	const memorySegments = options.memorySegments ?? [];
	const memoryRanges: MinidumpMemory64Range[] = memorySegments.map(
		(segment, index) => ({
			address: segment.start,
			dataSize: BigInt(segment.bytes.byteLength),
			dataRva: BigInt(index * 0x1000),
		}),
	);

	return {
		checksum: 0x12345678,
		timestamp: 0x13572468,
		flags: 0x55n,
		streams: new Map([
			[3, new DataView(new ArrayBuffer(0))],
			[6, new DataView(new ArrayBuffer(0))],
			[7, new DataView(new ArrayBuffer(0))],
			[15, new DataView(new ArrayBuffer(0))],
		]),
		systemInfo: options.systemInfo ?? {
			processorArchitecture: 9,
			processorArchitectureName: "x64",
			processorLevel: 0,
			processorRevision: 0,
			numberOfProcessors: 1,
			productType: 1,
			majorVersion: 10,
			minorVersion: 0,
			buildNumber: 22621,
			csdVersion: "",
			suiteMask: 0,
			cpu: {
				type: "other",
				processorFeatures: [0n, 0n],
			},
		},
		miscInfo: options.miscInfo ?? {
			sizeOfInfo: 44,
			flags1: 0x7,
			processId: 1234,
			processCreateTime: 1,
			processUserTime: 2,
			processKernelTime: 3,
			processorMaxMhz: 4000,
			processorCurrentMhz: 3500,
			processorMhzLimit: 3800,
			processorMaxIdleState: 1,
			processorCurrentIdleState: 0,
		},
		associatedThreads: options.associatedThreads ?? [],
		exceptionStream: options.exceptionStream ?? null,
		moduleList: options.moduleList ?? [],
		unloadedModuleList: options.unloadedModuleList ?? [],
		memoryRanges,
		readLocationBytes: (location) => {
			const bytes = locationBytes.get(location.rva);
			return bytes ? bytes.slice(0, location.dataSize) : null;
		},
		readMemoryAt: (address, size) => {
			const segment = findSegment(memorySegments, address);
			if (!segment) {
				return null;
			}

			const offset = Number(address - segment.start);
			const end = offset + size;
			return end <= segment.bytes.byteLength
				? segment.bytes.slice(offset, end)
				: null;
		},
	};
};

describe("MinidumpDebugInterface", () => {
	it("assigns synthetic addresses to saved thread contexts and reads them asynchronously", async () => {
		const threadContext = makeContextBytes(0x401000n);
		const source = buildSource({
			associatedThreads: [makeThread(7, makeLocation(0x1000))],
			locationBytes: [[0x1000, threadContext]],
			memorySegments: [
				{
					start: 0x5000n,
					bytes: new Uint8Array([0x90, 0x90, 0xc3]),
				},
			],
		});
		const debugInterface = new MinidumpDebugInterface(source);

		expect(debugInterface.dm.currentThreadId).toBe(7);
		expect(debugInterface.dm.currentContext).toBe(0n);
		expect(debugInterface.dm.threads[0]?.context).not.toBe(0n);
		expect(await debugInterface.read(0x5000n, 3)).toEqual(
			new Uint8Array([0x90, 0x90, 0xc3]),
		);

		const contextBytes = await debugInterface.read(
			debugInterface.dm.threads[0]!.context,
			0x100,
		);
		expect(contextBytes).toEqual(threadContext);
	});

	it("prefers exception contexts for current state and keeps concrete dump metadata", async () => {
		const threadContextBytes = makeContextBytes(0x401000n);
		const exceptionContextBytes = makeContextBytes(0x402000n);
		const source = buildSource({
			associatedThreads: [makeThread(11, makeLocation(0x1000))],
			exceptionStream: {
				threadId: 11,
				exceptionRecord: {
					exceptionCode: 0xc0000005,
					exceptionFlags: 0,
					exceptionRecord: 0n,
					exceptionAddress: 0x5000n,
					numberParameters: 0,
					exceptionInformation: [],
				},
				threadContext: makeLocation(0x2000),
			},
			locationBytes: [
				[0x1000, threadContextBytes],
				[0x2000, exceptionContextBytes],
			],
			memorySegments: [
				{
					start: 0x5000n,
					bytes: new Uint8Array([0xcc, 0xc3]),
				},
			],
			moduleList: [
				{
					baseOfImage: 0x140000000n,
					sizeOfImage: 0x1000,
					checkSum: 0,
					timeDateStamp: 0,
					moduleNameRva: 0,
					moduleName: "example.exe",
					versionInfo: {
						signature: 0,
						structVersion: 0,
						fileVersionMs: 0,
						fileVersionLs: 0,
						productVersionMs: 0,
						productVersionLs: 0,
						fileFlagsMask: 0,
						fileFlags: 0,
						fileOs: 0,
						fileType: 0,
						fileSubtype: 0,
						fileDateMs: 0,
						fileDateLs: 0,
					},
					cvRecord: makeLocation(0),
					codeViewInfo: {
						format: "RSDS",
						guid: "GUID",
						age: 2,
						pdbFileName: "example.pdb",
					},
					miscRecord: makeLocation(0),
					reserved0: 0n,
					reserved1: 0n,
				},
			],
		});
		const debugInterface = new MinidumpDebugInterface(source);
		const resolvedContext = await resolveDumpContext(debugInterface);

		expect(debugInterface.dm.currentThreadId).toBe(11);
		expect(debugInterface.dm.currentContext).not.toBe(0n);
		expect(debugInterface.checksum).toBe(0x12345678);
		expect(debugInterface.systemInfo?.processorArchitectureName).toBe("x64");
		expect(debugInterface.miscInfo?.processId).toBe(1234);
		expect(debugInterface.exceptionInfo?.exceptionRecord.exceptionCode).toBe(
			0xc0000005,
		);
		expect(debugInterface.dm.modules[0]?.pdb).toEqual({
			path: "example.pdb",
			guid: "GUID",
			age: 2,
		});
		expect(resolvedContext.threadId).toBe(11);
		expect(resolvedContext.instructionPointer).toBe(0x402000n);
		expect(resolvedContext.exceptionAddress).toBe(0x5000n);
		expect(resolvedContext.anchorAddress).toBe(0x5000n);
	});
});
