import { describe, expect, it } from "bun:test";
import { CONTEXT_AMD64, Context } from "./cpu_context";
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
import {
	MinidumpDebugInterface,
	type MinidumpDebugSource,
} from "./minidump_debug_interface";

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

const makeLocation = (
	rva: number,
	dataSize = 0x100,
): MinidumpLocationDescriptor => ({
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
		readMemoryAt: (address, size, minSize) => {
			const segment = findSegment(memorySegments, address);
			if (!segment) {
				return null;
			}

			const offset = Number(address - segment.start);
			const available = segment.bytes.byteLength - offset;
			const requiredSize = minSize ?? size;
			if (available < requiredSize) {
				return null;
			}

			const byteCount = Math.min(size, available);
			return segment.bytes.slice(offset, offset + byteCount);
		},
	};
};

describe("MinidumpDebugInterface", () => {
	it("stores thread context bytes directly and reads real memory asynchronously", async () => {
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
		const di = new MinidumpDebugInterface(source);

		expect(di.currentThread.state?.id).toBe(7);
		expect(di.currentContext.state).toBeInstanceOf(Context);
		expect(di.threads.state[0]?.context).toBeInstanceOf(Context);
		expect(di.threads.state[0]?.exception).toBeNull();
		expect(await di.read(0x5000n, 3)).toEqual(
			new Uint8Array([0x90, 0x90, 0xc3]),
		);
		expect(await di.read(0x5000n, 0x10, 1)).toEqual(
			new Uint8Array([0x90, 0x90, 0xc3]),
		);
	});

	it("prefers exception contexts for current state and keeps concrete dump metadata", () => {
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
		const di = new MinidumpDebugInterface(source);

		expect(di.currentThread.state?.id).toBe(11);
		expect(di.currentContext.state).toBeInstanceOf(Context);
		expect(di.currentContext.state?.ip).toBe(0x402000n);
		expect(di.checksum).toBe(0x12345678);
		expect(di.systemInfo?.processorArchitectureName).toBe("x64");
		expect(di.miscInfo?.processId).toBe(1234);
		expect(di.exceptionInfo?.exceptionRecord.exceptionCode).toBe(0xc0000005);
		expect(di.modules.state[0]?.pdb).toEqual({
			path: "example.pdb",
			guid: "GUID",
			age: 2,
		});

		const thread = di.threads.state[0];
		expect(thread?.exception).not.toBeNull();
		expect(thread?.exception?.code).toBe(0xc0000005);
		expect(thread?.exception?.address).toBe(0x5000n);
		expect(thread?.exception?.context).toBeInstanceOf(Context);
		expect(thread?.exception?.context?.ip).toBe(0x402000n);
	});

	it("selectThread switches current thread and context", () => {
		const thread1Context = makeContextBytes(0x401000n);
		const thread2Context = makeContextBytes(0x501000n);
		const source = buildSource({
			associatedThreads: [
				makeThread(1, makeLocation(0x1000)),
				makeThread(2, makeLocation(0x2000)),
			],
			locationBytes: [
				[0x1000, thread1Context],
				[0x2000, thread2Context],
			],
		});
		const di = new MinidumpDebugInterface(source);

		expect(di.currentThread.state?.id).toBe(1);
		expect(di.currentContext.state?.ip).toBe(0x401000n);

		di.selectThread(di.threads.state[1]);
		expect(di.currentThread.state?.id).toBe(2);
		expect(di.currentContext.state?.ip).toBe(0x501000n);
	});
});
