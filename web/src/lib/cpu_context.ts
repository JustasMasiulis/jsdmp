import { readU16, readU32, readU64 } from "./reader";

export const CONTEXT_AMD64 = 0x00100000;

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

	get sp(): bigint {
		return readU64(this._data, 0x98);
	}

	gpr(idx: number): bigint {
		return readU64(this._data, 0x78 + idx * 8);
	}

	seg(idx: number): number {
		return readU16(this._data, 0x38 + idx * 2);
	}
}
