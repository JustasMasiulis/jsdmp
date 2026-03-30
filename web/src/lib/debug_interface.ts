import type { Context } from "./cpu_context";
import type { Signal } from "./reactive";

export type Address = bigint;

export type DebugMemoryRange = {
	address: Address;
	size: bigint;
};

export type DebugThreadException = {
	code: number;
	flags: number;
	address: Address;
	record: bigint;
	parameters: bigint[];
	context: Context | null;
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
	exception: DebugThreadException | null;
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

export type DebugInterface = {
	readonly threads: Signal<DebugThread[]>;
	readonly modules: Signal<DebugModule[]>;
	readonly unloadedModules: Signal<DebugUnloadedModule[]>;
	readonly memoryRanges: Signal<DebugMemoryRange[]>;
	readonly currentThread: Signal<DebugThread | null>;
	readonly currentContext: Signal<Context | null>;

	read(address: bigint, size: number, minSize?: number): Promise<Uint8Array>;
	selectThread(thread: DebugThread): void;
};

export function findModuleForAddress<T extends { address: bigint; size: number }>(
	address: bigint,
	modules: readonly T[],
): T | null {
	for (const mod of modules) {
		if (address >= mod.address && address < mod.address + BigInt(mod.size)) {
			return mod;
		}
	}
	return null;
}
