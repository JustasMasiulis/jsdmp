import { describe, expect, it } from "bun:test";
import {
	Amd64Context,
	Arm64Context,
	CONTEXT_AMD64,
	CONTEXT_ARM64,
} from "./cpu_context";
import type {
	MinidumpAssociatedThread,
	MinidumpExceptionStream,
	MinidumpLocationDescriptor,
	MinidumpMiscInfo,
	MinidumpSystemInfo,
} from "./minidump";
import {
	MinidumpDebugInterface,
	type MinidumpDebugSource,
} from "./minidump_debug_interface";

type SourceOptions = {
	associatedThreads?: MinidumpAssociatedThread[];
	exceptionStream?: MinidumpExceptionStream | null;
	locationBytes?: Array<[number, Uint8Array]>;
	systemInfo?: MinidumpSystemInfo | null;
	miscInfo?: MinidumpMiscInfo | null;
};

const makeAmd64ContextBytes = (ip: bigint, sp = 0x8000n) => {
	const bytes = new Uint8Array(0x100);
	const view = new DataView(bytes.buffer);
	view.setUint32(0x30, CONTEXT_AMD64, true);
	view.setUint32(0x44, CONTEXT_AMD64, true);
	view.setBigUint64(0x98, sp, true);
	view.setBigUint64(0xf8, ip, true);
	return bytes;
};

const makeArm64ContextBytes = (ip: bigint, sp = 0x8000n) => {
	const bytes = new Uint8Array(0x310);
	const view = new DataView(bytes.buffer);
	view.setUint32(0x0, CONTEXT_ARM64, true);
	view.setUint32(0x4, 0x60000000, true);
	view.setBigUint64(0x100, sp, true);
	view.setBigUint64(0x108, ip, true);
	return bytes;
};

const makeLocation = (
	rva: number,
	dataSize = 0x310,
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

const makeSystemInfo = (
	arch: number,
	archName: string,
): MinidumpSystemInfo => ({
	processorArchitecture: arch,
	processorArchitectureName: archName,
	processorLevel: 0,
	processorRevision: 0,
	numberOfProcessors: 1,
	productType: 1,
	majorVersion: 10,
	minorVersion: 0,
	buildNumber: 22621,
	csdVersion: "",
	suiteMask: 0,
	cpu: { type: "other", processorFeatures: [0n, 0n] },
});

const buildSource = (options: SourceOptions = {}): MinidumpDebugSource => {
	const locationBytes = new Map(options.locationBytes ?? []);
	return {
		checksum: 0,
		timestamp: 0,
		flags: 0n,
		streams: new Map(),
		systemInfo: options.systemInfo ?? makeSystemInfo(9, "x64"),
		miscInfo: options.miscInfo ?? null,
		associatedThreads: options.associatedThreads ?? [],
		exceptionStream: options.exceptionStream ?? null,
		moduleList: [],
		unloadedModuleList: [],
		memoryRanges: [],
		readLocationBytes: (location) => {
			const bytes = locationBytes.get(location.rva);
			return bytes ? bytes.slice(0, location.dataSize) : null;
		},
		readMemoryAt: () => null,
	};
};

describe("MinidumpDebugInterface architecture routing", () => {
	it("creates AMD64 context for processorArchitecture 9", () => {
		const ctxBytes = makeAmd64ContextBytes(0x401000n);
		const source = buildSource({
			systemInfo: makeSystemInfo(9, "x64"),
			associatedThreads: [makeThread(1, makeLocation(0x1000, 0x100))],
			locationBytes: [[0x1000, ctxBytes]],
		});
		const di = new MinidumpDebugInterface(source);
		expect(di.processorArchitecture).toBe(9);
		expect(di.currentContext.state).toBeInstanceOf(Amd64Context);
		expect(di.currentContext.state?.ip).toBe(0x401000n);
	});

	it("creates ARM64 context for processorArchitecture 12", () => {
		const ctxBytes = makeArm64ContextBytes(0x801000n);
		const source = buildSource({
			systemInfo: makeSystemInfo(12, "ARM64"),
			associatedThreads: [makeThread(2, makeLocation(0x2000, 0x310))],
			locationBytes: [[0x2000, ctxBytes]],
		});
		const di = new MinidumpDebugInterface(source);
		expect(di.processorArchitecture).toBe(12);
		expect(di.currentContext.state).toBeInstanceOf(Arm64Context);
		expect(di.currentContext.state?.ip).toBe(0x801000n);
	});

	it("throws for unsupported processorArchitecture", () => {
		expect(() => {
			new MinidumpDebugInterface(
				buildSource({ systemInfo: makeSystemInfo(99, "unknown (99)") }),
			);
		}).toThrow("Unsupported processor architecture: 99 (unknown (99))");
	});

	it("exposes processorArchitecture as a public property", () => {
		const di = new MinidumpDebugInterface(
			buildSource({ systemInfo: makeSystemInfo(9, "x64") }),
		);
		expect(di.processorArchitecture).toBe(9);

		const di2 = new MinidumpDebugInterface(
			buildSource({ systemInfo: makeSystemInfo(12, "ARM64") }),
		);
		expect(di2.processorArchitecture).toBe(12);
	});
});
