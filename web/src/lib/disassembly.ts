import { readCString } from "./reader";
import { WASM_EXPORTS, WASM_MEMORY } from "./wasm";

export const MAX_INSTRUCTION_LENGTH = 15;

export type DisassembledControlFlowKind =
	| "none"
	| "call"
	| "conditional_branch"
	| "unconditional_branch"
	| "return"
	| "interrupt"
	| "syscall"
	| "system";

export type DisassembledControlFlow = {
	kind: DisassembledControlFlowKind;
	directTargetAddress: bigint | null;
};

const textDecoder = new TextDecoder();

const toControlFlowKind = (value: number): DisassembledControlFlowKind => {
	switch (value) {
		case 1:
			return "call";
		case 2:
			return "conditional_branch";
		case 3:
			return "unconditional_branch";
		case 4:
			return "return";
		case 5:
			return "interrupt";
		case 6:
			return "syscall";
		case 7:
			return "system";
		default:
			return "none";
	}
};

const copyUntilNull = (
	src: Uint8Array,
	offset: number,
	maxLength: number,
): Uint8Array => {
	const end = Math.min(offset + maxLength, src.byteLength);
	let i = offset;
	while (i < end && src[i] !== 0) i++;
	return src.slice(offset, i);
};

export class DisassembledInstruction {
	readonly length: number;
	readonly bytes: Uint8Array;
	readonly mnemonicId: number;
	readonly controlFlow: DisassembledControlFlow;

	private _formattedBytes: Uint8Array | null;
	private _mnemonicPtr: number;
	private _prefix: string | undefined;
	private _mnemonic: string | undefined;
	private _operands: string | undefined;

	constructor(
		length: number,
		bytes: Uint8Array,
		mnemonicId: number,
		controlFlow: DisassembledControlFlow,
		formattedBytes: Uint8Array,
		mnemonicPtr: number,
	) {
		this.length = length;
		this.bytes = bytes;
		this.mnemonicId = mnemonicId;
		this.controlFlow = controlFlow;
		this._formattedBytes = formattedBytes;
		this._mnemonicPtr = mnemonicPtr;
	}

	get prefix(): string {
		if (this._prefix === undefined) this._parse();
		return this._prefix!;
	}

	get mnemonic(): string {
		if (this._mnemonic === undefined) this._parse();
		return this._mnemonic!;
	}

	get operands(): string {
		if (this._operands === undefined) this._parse();
		return this._operands!;
	}

	private _resolveMnemonic(): string {
		const wasm = WASM_EXPORTS;
		if (!wasm) return "";
		return readCString(new Uint8Array(WASM_MEMORY.buffer), this._mnemonicPtr, 48);
	}

	private _parse(): void {
		const formatted = this._formattedBytes
			? textDecoder.decode(this._formattedBytes).trim()
			: "";
		this._formattedBytes = null;

		const mnemonicStr = this._resolveMnemonic();

		if (!formatted) {
			this._prefix = "";
			this._mnemonic = mnemonicStr || "???";
			this._operands = "";
			return;
		}

		if (mnemonicStr) {
			const idx = formatted.indexOf(mnemonicStr);
			if (idx >= 0) {
				this._prefix = formatted.slice(0, idx).trimEnd();
				this._mnemonic = mnemonicStr;
				this._operands = formatted
					.slice(idx + mnemonicStr.length)
					.trim();
				return;
			}
		}

		const firstSpace = formatted.search(/\s/);
		if (firstSpace < 0) {
			this._prefix = "";
			this._mnemonic = formatted;
			this._operands = "";
		} else {
			this._prefix = "";
			this._mnemonic = formatted.slice(0, firstSpace);
			this._operands = formatted.slice(firstSpace).trim();
		}
	}
}

export const disassembleInstruction = (
	bytes: Uint8Array,
	runtimeAddress: bigint,
): DisassembledInstruction | null => {
	if (bytes.byteLength === 0) {
		return null;
	}

	const wasm = WASM_EXPORTS;
	if (!wasm) {
		return null;
	}

	const candidateBytes =
		bytes.byteLength > MAX_INSTRUCTION_LENGTH
			? bytes.subarray(0, MAX_INSTRUCTION_LENGTH)
			: bytes;

	const disassemblyBufferPtr = wasm.wasm_get_disassembly_buffer();
	const wasmBytes = new Uint8Array(WASM_MEMORY.buffer);
	if (disassemblyBufferPtr + candidateBytes.byteLength > wasmBytes.byteLength) {
		return null;
	}
	wasmBytes.set(candidateBytes, disassemblyBufferPtr);

	const status = wasm.wasm_disassemble(
		candidateBytes.byteLength,
		runtimeAddress,
	);

	if (status < 0) {
		return null;
	}

	const length = wasm.wasm_get_disassembled_length();
	const mnemonicId = wasm.wasm_get_disassembled_mnemonic();
	const cfKind = toControlFlowKind(
		wasm.wasm_get_disassembled_control_flow_kind(),
	);
	const hasDirectTarget =
		wasm.wasm_get_disassembled_has_direct_target() !== 0;

	const formattedPtr = wasm.wasm_get_disassembled_text();
	const formattedBytes = copyUntilNull(wasmBytes, formattedPtr, 96);
	const mnemonicPtr = wasm.wasm_mnemonic_string(mnemonicId);

	return new DisassembledInstruction(
		length,
		candidateBytes.slice(0, length),
		mnemonicId,
		{
			kind: cfKind,
			directTargetAddress: hasDirectTarget
				? wasm.wasm_get_disassembled_direct_target()
				: null,
		},
		formattedBytes,
		mnemonicPtr,
	);
};
