const textDecoder = new TextDecoder();

export function readCString(
	memoryBytes: Uint8Array,
	pointer: number,
	maxLength: number,
): string {
	const start = pointer;

	let end = start;
	const limit = Math.min(memoryBytes.length, start + maxLength);
	while (end < limit && memoryBytes[end] !== 0) {
		end += 1;
	}

	return textDecoder.decode(memoryBytes.slice(start, end));
}

export function readU64(memory: DataView, offset: number): bigint {
	return memory.getBigUint64(offset, true);
}

export function readU32(memory: DataView, offset: number): number {
	return memory.getUint32(offset, true);
}

export function readU16(memory: DataView, offset: number): number {
	return memory.getUint16(offset, true);
}
