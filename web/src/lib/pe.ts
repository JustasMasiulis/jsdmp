export type MemoryReader = (
	address: bigint,
	size: number,
) => Promise<Uint8Array>;

export type RuntimeFunction = {
	beginAddress: number; // RVA
	endAddress: number; // RVA
	unwindInfoAddress: number; // RVA
};

export type UnwindCode = {
	codeOffset: number; // byte 0
	unwindOp: number; // byte 1, low nibble
	opInfo: number; // byte 1, high nibble
	frameOffset: number; // bytes 0-1 as uint16 (for slot data)
};

export type UnwindInfo = {
	version: number; // bits 0-2
	flags: number; // bits 3-7
	sizeOfProlog: number;
	countOfUnwindCodes: number;
	frameRegister: number; // low nibble
	frameOffset: number; // high nibble
	unwindCodes: UnwindCode[];
	chainedFunctionEntry: RuntimeFunction | null;
};

function dv(buf: Uint8Array): DataView {
	return new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
}

export const UNW_FLAG_CHAININFO = 0x04;

type PeSection = {
	virtualAddress: number;
	virtualSize: number;
	rawDataOffset: number;
	rawDataSize: number;
};

type PdataTable = {
	view: DataView;
	count: number;
};

type PeDirectory = {
	address: number;
	size: number;
};

const OFFSET_OPTIONAL_HEADER = 0x18;
const EXCEPTION_DIRECTORY_INDEX = 3;

export class PeFile {
	readonly headerBytes: Uint8Array;
	readonly headers: DataView;
	readonly sections: PeSection[];
	readonly directories: PeDirectory[];
	readonly sizeOfHeaders: number;
	readonly offsetNth: number;

	private pdata: PdataTable | null | undefined = undefined;

	constructor(headerBytes: Uint8Array) {
		if (headerBytes.length < 64) throw new Error("PE DOS header too short");

		this.headerBytes = headerBytes;
		this.headers = dv(headerBytes);

		if (this.headers.getUint16(0, true) !== 0x5a4d)
			throw new Error("PE DOS header magic number mismatch");

		this.offsetNth = this.headers.getUint32(0x3c, true);
		if (this.offsetNth + 0x108 > headerBytes.length)
			throw new Error("PE Optional header too short");

		if (this.headers.getUint32(this.offsetNth, true) !== 0x00004550)
			throw new Error("PE NT signature mismatch");

		const fileHeaderOffset = this.offsetNth + 4;
		const numberOfSections = this.headers.getUint16(
			fileHeaderOffset + 0x02,
			true,
		);
		const sizeOfOptionalHeader = this.headers.getUint16(
			fileHeaderOffset + 0x10,
			true,
		);

		this.sizeOfHeaders = this.headers.getUint32(
			this.offsetNth + OFFSET_OPTIONAL_HEADER + 0x3c,
			true,
		);

		if (this.sizeOfHeaders > headerBytes.length)
			throw new Error("PE size of headers too long");

		const offsetDirectories = this.offsetNth + OFFSET_OPTIONAL_HEADER + 0x70;
		const numDirectories = this.headers.getUint32(
			offsetDirectories - 0x04,
			true,
		);

		if (offsetDirectories + numDirectories * 0x08 > headerBytes.length)
			throw new Error("PE directory table too long");

		this.directories = [];
		for (let i = 0; i < numDirectories; i++) {
			const off = offsetDirectories + i * 0x08;
			this.directories.push({
				address: this.headers.getUint32(off, true),
				size: this.headers.getUint32(off + 4, true),
			});
		}

		const sectionTableOffset =
			this.offsetNth + OFFSET_OPTIONAL_HEADER + sizeOfOptionalHeader;
		if (sectionTableOffset + numberOfSections * 0x28 > headerBytes.length)
			throw new Error("PE section table too long");

		this.sections = [];
		for (let i = 0; i < numberOfSections; i++) {
			const off = sectionTableOffset + i * 0x28;
			this.sections.push({
				virtualSize: this.headers.getUint32(off + 8, true),
				virtualAddress: this.headers.getUint32(off + 12, true),
				rawDataSize: this.headers.getUint32(off + 16, true),
				rawDataOffset: this.headers.getUint32(off + 20, true),
			});
		}
	}

	rvaToFileOffset(
		rva: number,
		size: number,
	): { fileOffset: number; availableSize: number } | null {
		const firstSectionRva =
			this.sections.length > 0 ? this.sections[0].virtualAddress : 0;
		if (rva < firstSectionRva) {
			const available = Math.min(size, firstSectionRva - rva);
			return { fileOffset: rva, availableSize: available };
		}

		for (const section of this.sections) {
			if (
				rva >= section.virtualAddress &&
				rva < section.virtualAddress + section.virtualSize
			) {
				const offsetInSection = rva - section.virtualAddress;
				if (offsetInSection >= section.rawDataSize) return null;
				const fileOffset = section.rawDataOffset + offsetInSection;
				const availableSize = Math.min(
					size,
					section.rawDataSize - offsetInSection,
				);
				return { fileOffset, availableSize };
			}
		}
		return null;
	}

	readHeader(offset: number, size: number): Uint8Array | null {
		if (offset + size <= this.headerBytes.length) {
			return this.headerBytes.subarray(offset, offset + size);
		}
		return null;
	}

	private async loadPdata(
		reader: MemoryReader,
		moduleBase: bigint,
	): Promise<PdataTable | null> {
		if (this.pdata !== undefined) return this.pdata;

		const exc = this.directories[EXCEPTION_DIRECTORY_INDEX];
		if (!exc || exc.address === 0 || exc.size === 0) {
			this.pdata = null;
			return null;
		}

		const raw = await reader(moduleBase + BigInt(exc.address), exc.size);
		this.pdata = { view: dv(raw), count: Math.floor(exc.size / 12) };
		return this.pdata;
	}

	async getAllRuntimeFunctions(
		reader: MemoryReader,
		moduleBase: bigint,
	): Promise<RuntimeFunction[]> {
		const pdata = await this.loadPdata(reader, moduleBase);
		if (!pdata) return [];

		const { view, count } = pdata;
		const entries: RuntimeFunction[] = [];
		for (let i = 0; i < count; i++) {
			const off = i * 12;
			entries.push({
				beginAddress: view.getUint32(off, true),
				endAddress: view.getUint32(off + 4, true),
				unwindInfoAddress: view.getUint32(off + 8, true),
			});
		}
		return entries;
	}

	async findRuntimeFunction(
		reader: MemoryReader,
		moduleBase: bigint,
		rva: number,
	): Promise<RuntimeFunction | null> {
		const pdata = await this.loadPdata(reader, moduleBase);
		if (!pdata) return null;

		const { view, count } = pdata;
		let lo = 0;
		let hi = count - 1;

		while (lo <= hi) {
			const mid = (lo + hi) >>> 1;
			const off = mid * 12;
			const beginAddr = view.getUint32(off, true);
			const endAddr = view.getUint32(off + 4, true);

			if (rva < beginAddr) {
				hi = mid - 1;
			} else if (rva >= endAddr) {
				lo = mid + 1;
			} else {
				return {
					beginAddress: beginAddr,
					endAddress: endAddr,
					unwindInfoAddress: view.getUint32(off + 8, true),
				};
			}
		}

		return null;
	}
}

export async function readUnwindInfo(
	reader: MemoryReader,
	moduleBase: bigint,
	rva: number,
): Promise<UnwindInfo | null> {
	const hdrBuf = await reader(moduleBase + BigInt(rva), 4);
	const byte0 = hdrBuf[0];
	const version = byte0 & 0x07;
	const flags = (byte0 >> 3) & 0x1f;
	const sizeOfProlog = hdrBuf[1];
	const countOfUnwindCodes = hdrBuf[2];
	const byte3 = hdrBuf[3];
	const frameRegister = byte3 & 0x0f;
	const frameOffset = (byte3 >> 4) & 0x0f;

	const codesSize = countOfUnwindCodes * 2;
	const alignedCodesSize =
		codesSize + (codesSize % 4 === 0 ? 0 : 4 - (codesSize % 4));
	const extraSize =
		flags & UNW_FLAG_CHAININFO ? alignedCodesSize + 12 : codesSize;
	const codeBuf =
		extraSize > 0
			? await reader(moduleBase + BigInt(rva + 4), extraSize)
			: new Uint8Array(0);

	const unwindCodes: UnwindCode[] = [];
	for (let i = 0; i < countOfUnwindCodes; i++) {
		const off = i * 2;
		const codeOffset = codeBuf[off];
		const b1 = codeBuf[off + 1];
		const unwindOp = b1 & 0x0f;
		const opInfo = (b1 >> 4) & 0x0f;
		const frameOff = codeBuf[off] | (codeBuf[off + 1] << 8);
		unwindCodes.push({ codeOffset, unwindOp, opInfo, frameOffset: frameOff });
	}

	let chainedFunctionEntry: RuntimeFunction | null = null;
	if (flags & UNW_FLAG_CHAININFO) {
		const chainOff = alignedCodesSize;
		const cv = dv(codeBuf.subarray(chainOff, chainOff + 12));
		chainedFunctionEntry = {
			beginAddress: cv.getUint32(0, true),
			endAddress: cv.getUint32(4, true),
			unwindInfoAddress: cv.getUint32(8, true),
		};
	}

	return {
		version,
		flags,
		sizeOfProlog,
		countOfUnwindCodes,
		frameRegister,
		frameOffset,
		unwindCodes,
		chainedFunctionEntry,
	};
}
