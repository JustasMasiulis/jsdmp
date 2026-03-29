import type { Context } from "./cpu_context";

export type Address = bigint;

export type DebugMemoryRange = {
	address: Address;
	size: bigint;
};

export type DebugThread = {
	id: number;
	suspendCount: number;
	priorityClass: number;
	priority: number;
	teb: Address;
	stack: {
		address: Address;
	};
	context: Context | null;
	dumpFlags: number;
	dumpError: number;
	exitStatus: number;
	createTime: bigint;
	exitTime: bigint;
	kernelTime: bigint;
	userTime: bigint;
	startAddress: Address;
	affinity: bigint;
};

export type DebugModule = {
	address: Address;
	size: number;
	checksum: number;
	timeDateStamp: number;
	path: string;
	pdb?: {
		path: string;
		guid: string;
		age: number;
	};
};

export type DebugUnloadedModule = {
	address: Address;
	size: number;
	checksum: number;
	timeDateStamp: number;
	path: string;
};

export type DebugDataModel = {
	threads: DebugThread[];
	modules: DebugModule[];
	unloadedModules: DebugUnloadedModule[];
	memoryRanges: DebugMemoryRange[];

	currentThreadId: number;
	currentContext: Context | null;
};

export type DebugInterface = {
	readonly dm: DebugDataModel;

	read(address: bigint, size: number, minSize?: number): Promise<Uint8Array>;
};
