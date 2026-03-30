import { readU16, readU32, readU64 } from "./reader";

export const CONTEXT_AMD64 = 0x00100000;

export const GPR_NAMES = [
	"rax",
	"rcx",
	"rdx",
	"rbx",
	"rsp",
	"rbp",
	"rsi",
	"rdi",
	"r8",
	"r9",
	"r10",
	"r11",
	"r12",
	"r13",
	"r14",
	"r15",
] as const;

export class Context {
	private _address: bigint;
	private _data: DataView;

	constructor(data: ArrayBuffer | ArrayBufferView, address: bigint = 0n) {
		this._address = address;
		this._data =
			data instanceof DataView
				? data
				: ArrayBuffer.isView(data)
					? new DataView(data.buffer, data.byteOffset, data.byteLength)
					: new DataView(data);

		if ((this.context_flags & CONTEXT_AMD64) !== CONTEXT_AMD64) {
			throw new Error("Invalid context flags");
		}
	}

	clone(): Context {
		const src = new Uint8Array(
			this._data.buffer,
			this._data.byteOffset,
			this._data.byteLength,
		);
		const buf = new ArrayBuffer(src.byteLength);
		new Uint8Array(buf).set(src);
		return new Context(buf, this._address);
	}

	get address(): bigint {
		return this._address;
	}

	get context_flags(): number {
		return readU32(this._data, 0x30);
	}

	get flags(): number {
		return readU32(this._data, 0x44);
	}

	get ip(): bigint {
		return readU64(this._data, 0xf8);
	}

	set ip(value: bigint) {
		this._data.setBigUint64(0xf8, value, true);
	}

	get sp(): bigint {
		return readU64(this._data, 0x98);
	}

	set sp(value: bigint) {
		this._data.setBigUint64(0x98, value, true);
	}

	gpr(idx: number): bigint {
		return readU64(this._data, 0x78 + idx * 8);
	}

	setGpr(idx: number, value: bigint) {
		this._data.setBigUint64(0x78 + idx * 8, value, true);
	}

	xmm(idx: number): [bigint, bigint] {
		const off = 0x1a0 + idx * 16;
		return [readU64(this._data, off), readU64(this._data, off + 8)];
	}

	setXmm(idx: number, lo: bigint, hi: bigint) {
		const off = 0x1a0 + idx * 16;
		this._data.setBigUint64(off, lo, true);
		this._data.setBigUint64(off + 8, hi, true);
	}

	seg(idx: number): number {
		return readU16(this._data, 0x38 + idx * 2);
	}
}
