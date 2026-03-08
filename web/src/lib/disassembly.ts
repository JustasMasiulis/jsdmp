import type {
	MiniDump,
	MinidumpAssociatedThread,
	MinidumpLocationDescriptor,
} from "./minidump";

const CONTEXT_AMD64 = 0x00100000;
const MAX_INSTRUCTION_LENGTH = 15;
const DISASSEMBLY_LOOKBACK_BYTES = 64;
const DISASSEMBLY_PREV_LINES = 8;
const DISASSEMBLY_NEXT_LINES = 8;

export type WasmDisassemblerExports = {
	wasm_get_disassembly_buffer: () => bigint;
	wasm_get_disassembled_text: () => bigint;
	wasm_get_disassembled_length: () => number;
	wasm_get_disassembled_mnemonic: () => number;
	wasm_disassemble: (length: number, runtimeAddress: bigint) => number;
	wasm_mnemonic_string: (mnemonic: number) => bigint;
};

export type DecodedThreadContextX64 = {
	contextFlags: number;
	rflags: number;
	rax: bigint;
	rbx: bigint;
	rcx: bigint;
	rdx: bigint;
	rsi: bigint;
	rdi: bigint;
	rbp: bigint;
	rsp: bigint;
	r8: bigint;
	r9: bigint;
	r10: bigint;
	r11: bigint;
	r12: bigint;
	r13: bigint;
	r14: bigint;
	r15: bigint;
	rip: bigint;
};

export type DisassemblyStatus =
	| "ok"
	| "unsupported_arch"
	| "missing_context"
	| "missing_memory"
	| "decode_error";

export type DisassemblyLine = {
	address: bigint;
	bytesHex: string;
	mnemonic: string;
	operands: string;
	isCurrent: boolean;
};

export type DebugDisassemblyView = {
	status: DisassemblyStatus;
	message: string;
	threadId: number | null;
	instructionPointer: bigint | null;
	exceptionAddress: bigint | null;
	exceptionCode: number | null;
	lines: DisassemblyLine[];
	registers: DecodedThreadContextX64 | null;
};

type DecodedInstruction = {
	address: bigint;
	length: number;
	bytesHex: string;
	mnemonic: string;
	operands: string;
};

const textDecoder = new TextDecoder();

const formatBytesHex = (bytes: Uint8Array) =>
	[...bytes]
		.map((value) => value.toString(16).toUpperCase().padStart(2, "0"))
		.join(" ");

const readCString = (
	memoryBytes: Uint8Array,
	pointer: bigint,
	maxLength: number,
): string => {
	const start = Number(pointer);
	if (
		!Number.isSafeInteger(start) ||
		start < 0 ||
		start >= memoryBytes.length
	) {
		return "";
	}

	let end = start;
	const limit = Math.min(memoryBytes.length, start + maxLength);
	while (end < limit && memoryBytes[end] !== 0) {
		end += 1;
	}

	const copyBuffer = new ArrayBuffer(end - start);
	const copy = new Uint8Array(copyBuffer);
	copy.set(new Uint8Array(memoryBytes.buffer, start, end - start));

	return textDecoder.decode(copy);
};

const parseFormattedInstruction = (
	formatted: string,
	fallbackMnemonic: string,
): { mnemonic: string; operands: string } => {
	const trimmed = formatted.trim();
	if (!trimmed) {
		return {
			mnemonic: fallbackMnemonic || "???",
			operands: "",
		};
	}

	const firstSpace = trimmed.search(/\s/);
	if (firstSpace < 0) {
		return {
			mnemonic: trimmed,
			operands: "",
		};
	}

	return {
		mnemonic: trimmed.slice(0, firstSpace),
		operands: trimmed.slice(firstSpace).trim(),
	};
};

const decodeX64Context = (
	contextBytes: Uint8Array,
): DecodedThreadContextX64 | null => {
	if (contextBytes.byteLength < 0x100) {
		return null;
	}

	const view = new DataView(
		contextBytes.buffer,
		contextBytes.byteOffset,
		contextBytes.byteLength,
	);
	const contextFlags = view.getUint32(0x30, true);
	if ((contextFlags & CONTEXT_AMD64) !== CONTEXT_AMD64) {
		return null;
	}

	const readU64 = (offset: number) => view.getBigUint64(offset, true);

	return {
		contextFlags,
		rflags: view.getUint32(0x44, true),
		rax: readU64(0x78),
		rbx: readU64(0x90),
		rcx: readU64(0x80),
		rdx: readU64(0x88),
		rsi: readU64(0xa8),
		rdi: readU64(0xb0),
		rbp: readU64(0xa0),
		rsp: readU64(0x98),
		r8: readU64(0xb8),
		r9: readU64(0xc0),
		r10: readU64(0xc8),
		r11: readU64(0xd0),
		r12: readU64(0xd8),
		r13: readU64(0xe0),
		r14: readU64(0xe8),
		r15: readU64(0xf0),
		rip: readU64(0xf8),
	};
};

const decodeContextFromLocation = (
	dump: MiniDump,
	location: MinidumpLocationDescriptor | null | undefined,
): DecodedThreadContextX64 | null => {
	if (!location) {
		return null;
	}

	const bytes = dump.readLocationBytes(location);
	if (!bytes) {
		return null;
	}

	return decodeX64Context(bytes);
};

const resolveContext = (
	dump: MiniDump,
): {
	threadId: number | null;
	registers: DecodedThreadContextX64 | null;
} => {
	const exceptionThreadId = dump.exceptionStream?.threadId ?? null;
	const exceptionContext = decodeContextFromLocation(
		dump,
		dump.exceptionStream?.threadContext,
	);
	if (exceptionContext) {
		return { threadId: exceptionThreadId, registers: exceptionContext };
	}

	const tryThread = (thread: MinidumpAssociatedThread) => {
		const decoded = decodeContextFromLocation(
			dump,
			thread.thread?.threadContext,
		);
		if (!decoded) {
			return null;
		}
		return {
			threadId: thread.threadId,
			registers: decoded,
		};
	};

	if (exceptionThreadId !== null) {
		const exceptionThread = (dump.associatedThreads ?? []).find(
			(thread) => thread.threadId === exceptionThreadId,
		);
		if (exceptionThread) {
			const resolved = tryThread(exceptionThread);
			if (resolved) {
				return resolved;
			}
		}
	}

	for (const thread of dump.associatedThreads ?? []) {
		const resolved = tryThread(thread);
		if (resolved) {
			return resolved;
		}
	}

	return {
		threadId: exceptionThreadId,
		registers: null,
	};
};

const decodeInstructionAt = (
	dump: MiniDump,
	wasm: WasmDisassemblerExports,
	memory: WebAssembly.Memory,
	address: bigint,
): DecodedInstruction | null => {
	const bytes = dump.readMemoryAt(address, MAX_INSTRUCTION_LENGTH);
	if (!bytes || bytes.byteLength === 0) {
		return null;
	}

	const disassemblyBufferPtr = Number(wasm.wasm_get_disassembly_buffer());
	if (!Number.isSafeInteger(disassemblyBufferPtr) || disassemblyBufferPtr < 0) {
		return null;
	}

	const wasmBytes = new Uint8Array(memory.buffer);
	if (disassemblyBufferPtr + bytes.byteLength > wasmBytes.byteLength) {
		return null;
	}
	wasmBytes.set(bytes, disassemblyBufferPtr);

	const status = wasm.wasm_disassemble(bytes.byteLength, address);
	if (status < 0) {
		return null;
	}

	const length = wasm.wasm_get_disassembled_length();
	if (
		length <= 0 ||
		length > MAX_INSTRUCTION_LENGTH ||
		length > bytes.byteLength
	) {
		return null;
	}

	const mnemonicId = wasm.wasm_get_disassembled_mnemonic();
	const mnemonicPointer = wasm.wasm_mnemonic_string(mnemonicId);
	const mnemonic = readCString(wasmBytes, mnemonicPointer, 48);
	const formattedPointer = wasm.wasm_get_disassembled_text();
	const formattedText = readCString(wasmBytes, formattedPointer, 96);
	const parsed = parseFormattedInstruction(formattedText, mnemonic);
	const exactBytes = bytes.subarray(0, length);

	return {
		address,
		length,
		bytesHex: formatBytesHex(exactBytes),
		mnemonic: parsed.mnemonic,
		operands: parsed.operands,
	};
};

const findPreviousInstructionStart = (
	dump: MiniDump,
	wasm: WasmDisassemblerExports,
	memory: WebAssembly.Memory,
	targetAddress: bigint,
): bigint | null => {
	for (let delta = 1; delta <= DISASSEMBLY_LOOKBACK_BYTES; delta += 1) {
		const candidate = targetAddress - BigInt(delta);
		if (candidate < 0n) {
			break;
		}

		if (!dump.findMemoryRange(candidate)) {
			continue;
		}

		let cursor = candidate;
		let steps = 0;
		while (cursor < targetAddress && steps < DISASSEMBLY_LOOKBACK_BYTES) {
			const decoded = decodeInstructionAt(dump, wasm, memory, cursor);
			if (!decoded) {
				break;
			}

			cursor += BigInt(decoded.length);
			if (cursor === targetAddress) {
				return candidate;
			}
			if (cursor > targetAddress) {
				break;
			}

			steps += 1;
		}
	}

	return null;
};

const buildListing = (
	dump: MiniDump,
	wasm: WasmDisassemblerExports,
	memory: WebAssembly.Memory,
	instructionPointer: bigint,
): DisassemblyLine[] | null => {
	const current = decodeInstructionAt(dump, wasm, memory, instructionPointer);
	if (!current) {
		return null;
	}

	const previous: DisassemblyLine[] = [];
	let cursor = instructionPointer;
	for (let i = 0; i < DISASSEMBLY_PREV_LINES; i += 1) {
		const previousStart = findPreviousInstructionStart(
			dump,
			wasm,
			memory,
			cursor,
		);
		if (previousStart === null) {
			break;
		}

		const decoded = decodeInstructionAt(dump, wasm, memory, previousStart);
		if (!decoded) {
			break;
		}

		previous.unshift({
			address: decoded.address,
			bytesHex: decoded.bytesHex,
			mnemonic: decoded.mnemonic,
			operands: decoded.operands,
			isCurrent: false,
		});
		cursor = previousStart;
	}

	const lines: DisassemblyLine[] = [
		...previous,
		{
			address: current.address,
			bytesHex: current.bytesHex,
			mnemonic: current.mnemonic,
			operands: current.operands,
			isCurrent: true,
		},
	];

	let nextAddress = instructionPointer + BigInt(current.length);
	for (let i = 0; i < DISASSEMBLY_NEXT_LINES; i += 1) {
		const decoded = decodeInstructionAt(dump, wasm, memory, nextAddress);
		if (!decoded) {
			break;
		}
		lines.push({
			address: decoded.address,
			bytesHex: decoded.bytesHex,
			mnemonic: decoded.mnemonic,
			operands: decoded.operands,
			isCurrent: false,
		});
		nextAddress += BigInt(decoded.length);
	}

	return lines;
};

const baseView = (
	dump: MiniDump,
	threadId: number | null,
	registers: DecodedThreadContextX64 | null,
	instructionPointer: bigint | null,
): Omit<DebugDisassemblyView, "status" | "message" | "lines"> => ({
	threadId,
	registers,
	instructionPointer,
	exceptionAddress:
		dump.exceptionStream?.exceptionRecord.exceptionAddress ?? null,
	exceptionCode: dump.exceptionStream?.exceptionRecord.exceptionCode ?? null,
});

export const buildDisassemblyView = (
	dump: MiniDump,
	wasm: WasmDisassemblerExports,
	memory: WebAssembly.Memory,
): DebugDisassemblyView => {
	const processorArchitecture = dump.systemInfo?.processorArchitecture;
	if (processorArchitecture !== undefined && processorArchitecture !== 9) {
		return {
			...baseView(dump, null, null, null),
			status: "unsupported_arch",
			message: "Disassembly view currently supports x64 dumps only.",
			lines: [],
		};
	}

	const resolved = resolveContext(dump);
	const exceptionAddress =
		dump.exceptionStream?.exceptionRecord.exceptionAddress ?? null;
	const rip = resolved.registers?.rip ?? null;
	const instructionPointer =
		exceptionAddress && dump.findMemoryRange(exceptionAddress)
			? exceptionAddress
			: (rip ?? exceptionAddress);

	if (!instructionPointer) {
		return {
			...baseView(dump, resolved.threadId, resolved.registers, null),
			status: "missing_context",
			message:
				"No x64 thread context or instruction pointer was found in the dump.",
			lines: [],
		};
	}

	if (!dump.findMemoryRange(instructionPointer)) {
		return {
			...baseView(
				dump,
				resolved.threadId,
				resolved.registers,
				instructionPointer,
			),
			status: "missing_memory",
			message:
				"Instruction pointer is not present in dump memory ranges; cannot disassemble.",
			lines: [],
		};
	}

	const lines = buildListing(dump, wasm, memory, instructionPointer);
	if (!lines || lines.length === 0) {
		return {
			...baseView(
				dump,
				resolved.threadId,
				resolved.registers,
				instructionPointer,
			),
			status: "decode_error",
			message:
				"Failed to decode instructions at the selected instruction pointer.",
			lines: [],
		};
	}

	return {
		...baseView(
			dump,
			resolved.threadId,
			resolved.registers,
			instructionPointer,
		),
		status: "ok",
		message: "Decoded surrounding instructions.",
		lines,
	};
};
