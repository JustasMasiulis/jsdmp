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

	const copyBuffer = new ArrayBuffer(end - start);
	const copy = new Uint8Array(copyBuffer);
	copy.set(new Uint8Array(memoryBytes.buffer, start, end - start));

	return textDecoder.decode(copy);
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
