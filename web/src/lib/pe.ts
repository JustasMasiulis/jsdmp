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

/**
 * Loaded .pdata: the entire RUNTIME_FUNCTION array read in one shot,
 * kept as a raw DataView for zero-copy binary search.
 */
type PdataTable = {
	view: DataView;
	count: number;
};

const pdataCache = new Map<bigint, PdataTable | null>();

async function loadPdata(
	reader: MemoryReader,
	moduleBase: bigint,
): Promise<PdataTable | null> {
	const cached = pdataCache.get(moduleBase);
	if (cached !== undefined) return cached;

	const result = await loadPdataUncached(reader, moduleBase);
	pdataCache.set(moduleBase, result);
	return result;
}

async function loadPdataUncached(
	reader: MemoryReader,
	moduleBase: bigint,
): Promise<PdataTable | null> {
	// DOS header
	const dosHeader = dv(await reader(moduleBase, 0x40));
	if (dosHeader.getUint16(0, true) !== 0x5a4d) return null;
	const eLfanew = dosHeader.getUint32(0x3c, true);

	// PE signature
	const peSigBuf = dv(await reader(moduleBase + BigInt(eLfanew), 4));
	if (peSigBuf.getUint32(0, true) !== 0x00004550) return null;

	// Optional header (PE32+ only)
	const optBuf = dv(
		await reader(moduleBase + BigInt(eLfanew + 24), 120),
	);
	if (optBuf.getUint16(0, true) !== 0x20b) return null;

	// Exception directory: data directory index 3, at optional header offset 112
	const excRva = optBuf.getUint32(112, true);
	const excSize = optBuf.getUint32(116, true);
	if (excRva === 0 || excSize === 0) return null;

	// Read entire .pdata in one go
	const raw = await reader(moduleBase + BigInt(excRva), excSize);
	return {
		view: dv(raw),
		count: Math.floor(excSize / 12),
	};
}

/**
 * Binary-search the module's .pdata for the RUNTIME_FUNCTION covering `rva`.
 * The entire exception directory is read once per module and cached.
 */
export async function findRuntimeFunction(
	reader: MemoryReader,
	moduleBase: bigint,
	rva: number,
): Promise<RuntimeFunction | null> {
	const pdata = await loadPdata(reader, moduleBase);
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

/**
 * Read and parse an UNWIND_INFO structure at the given RVA.
 */
export async function readUnwindInfo(
	reader: MemoryReader,
	moduleBase: bigint,
	rva: number,
): Promise<UnwindInfo | null> {
	// Read the fixed header (4 bytes)
	const hdrBuf = await reader(moduleBase + BigInt(rva), 4);
	const byte0 = hdrBuf[0];
	const version = byte0 & 0x07;
	const flags = (byte0 >> 3) & 0x1f;
	const sizeOfProlog = hdrBuf[1];
	const countOfUnwindCodes = hdrBuf[2];
	const byte3 = hdrBuf[3];
	const frameRegister = byte3 & 0x0f;
	const frameOffset = (byte3 >> 4) & 0x0f;

	// Read unwind codes: countOfUnwindCodes * 2 bytes, starting at offset 4
	const codesSize = countOfUnwindCodes * 2;
	// Also potentially need chained entry after codes (aligned to 4 bytes)
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
		// frameOffset is the entire 2-byte slot as uint16 LE
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
