export type Address = bigint;

export type DebugLocation = {
	size: number;
	rva: number;
};

export type DebugMemoryRange = {
	address: Address;
	size: bigint;
};

export type DebugCodeViewInfo =
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

export type DebugThread = {
	id: number;
	suspendCount: number;
	priorityClass: number;
	priority: number;
	teb: Address;
	stack: {
		address: Address;
		location: DebugLocation;
	};
	context: Address;
	contextLocation: DebugLocation;
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
	codeViewRecord: DebugLocation;
	codeViewInfo: DebugCodeViewInfo | null;
	miscRecord: DebugLocation;
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
	currentContext: Address; // 0 if the context from current thread should be used
};

export type DebugInterface = {
	readonly dm: DebugDataModel;

	read(address: bigint, size: number, minSize?: number): Promise<Uint8Array>;
};
