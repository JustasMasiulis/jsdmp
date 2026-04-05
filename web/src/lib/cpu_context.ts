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

export const CONTEXT_ARM64 = 0x00400000;

export const ARM64_GPR_NAMES = [
	"x0",
	"x1",
	"x2",
	"x3",
	"x4",
	"x5",
	"x6",
	"x7",
	"x8",
	"x9",
	"x10",
	"x11",
	"x12",
	"x13",
	"x14",
	"x15",
	"x16",
	"x17",
	"x18",
	"x19",
	"x20",
	"x21",
	"x22",
	"x23",
	"x24",
	"x25",
	"x26",
	"x27",
	"x28",
	"fp",
	"lr",
] as const;

export class Arm64Context {
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

		if ((this.context_flags & CONTEXT_ARM64) !== CONTEXT_ARM64)
			throw new Error("Invalid context flags");
	}

	clone(): Arm64Context {
		const src = new Uint8Array(
			this._data.buffer,
			this._data.byteOffset,
			this._data.byteLength,
		);
		const buf = new ArrayBuffer(src.byteLength);
		new Uint8Array(buf).set(src);
		return new Arm64Context(buf, this._address);
	}

	get address(): bigint {
		return this._address;
	}

	get context_flags(): number {
		return readU32(this._data, 0x0);
	}

	get cpsr(): number {
		return readU32(this._data, 0x4);
	}

	get ip(): bigint {
		return readU64(this._data, 0x108);
	}

	set ip(value: bigint) {
		this._data.setBigUint64(0x108, value, true);
	}

	get sp(): bigint {
		return readU64(this._data, 0x100);
	}

	set sp(value: bigint) {
		this._data.setBigUint64(0x100, value, true);
	}

	gpr(idx: number): bigint {
		if (idx < 0 || idx > 30) throw new RangeError("GPR index must be 0-30");
		if (idx <= 28) return readU64(this._data, 0x08 + idx * 8);
		if (idx === 29) return readU64(this._data, 0xf0);
		return readU64(this._data, 0xf8);
	}

	setGpr(idx: number, value: bigint) {
		if (idx < 0 || idx > 30) throw new RangeError("GPR index must be 0-30");
		if (idx <= 28) this._data.setBigUint64(0x08 + idx * 8, value, true);
		else if (idx === 29) this._data.setBigUint64(0xf0, value, true);
		else this._data.setBigUint64(0xf8, value, true);
	}

	simd(idx: number): [bigint, bigint] {
		if (idx < 0 || idx > 31) throw new RangeError("SIMD index must be 0-31");
		const off = 0x110 + idx * 16;
		return [readU64(this._data, off), readU64(this._data, off + 8)];
	}

	setSimd(idx: number, lo: bigint, hi: bigint) {
		if (idx < 0 || idx > 31) throw new RangeError("SIMD index must be 0-31");
		const off = 0x110 + idx * 16;
		this._data.setBigUint64(off, lo, true);
		this._data.setBigUint64(off + 8, hi, true);
	}
}

export type CpuContext = Context | Arm64Context;
