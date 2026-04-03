import { type CommandOutput, parseAddressAndCount } from "../commandEngine";
import { fmtHex } from "../formatting";
import type { MinidumpDebugInterface } from "../minidump_debug_interface";

export async function displayBytesCommand(
	dbg: MinidumpDebugInterface,
	args: string,
): Promise<CommandOutput> {
	const { address, count } = parseAddressAndCount(
		args,
		dbg.currentContext.state,
		128,
	);

	let data: Uint8Array;
	try {
		data = await dbg.read(address, count, 1);
	} catch {
		return {
			lines: [`Memory read failed at ${fmtHex(address, 16).toLowerCase()}`],
			isError: true,
		};
	}

	const lines: string[] = [];
	for (let offset = 0; offset < count; offset += 16) {
		const lineAddr = address + BigInt(offset);
		const rowEnd = Math.min(offset + 16, count);
		let hex = "";
		let ascii = "";

		for (let i = 0; i < 16; i++) {
			if (i === 8) hex += "-";
			else if (i > 0) hex += " ";

			const byteIdx = offset + i;
			if (byteIdx >= rowEnd) {
				hex += "  ";
				ascii += " ";
			} else if (byteIdx < data.length) {
				hex += fmtHex(data[byteIdx], 2).toLowerCase();
				const ch = data[byteIdx];
				ascii += ch >= 0x20 && ch <= 0x7e ? String.fromCharCode(ch) : ".";
			} else {
				hex += "??";
				ascii += "?";
			}
		}

		lines.push(`${fmtHex(lineAddr, 16).toLowerCase()}  ${hex}  ${ascii}`);
	}
	return { lines };
}

export async function displayWordsCommand(
	dbg: MinidumpDebugInterface,
	args: string,
	unitSize: number,
	unitsPerLine: number,
	defaultCount: number,
): Promise<CommandOutput> {
	const { address, count } = parseAddressAndCount(
		args,
		dbg.currentContext.state,
		defaultCount,
	);
	const totalBytes = count * unitSize;

	let data: Uint8Array;
	try {
		data = await dbg.read(address, totalBytes, 1);
	} catch {
		return {
			lines: [`Memory read failed at ${fmtHex(address, 16).toLowerCase()}`],
			isError: true,
		};
	}

	const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
	const lines: string[] = [];
	const missingUnit = "?".repeat(unitSize * 2);

	for (let unitOffset = 0; unitOffset < count; unitOffset += unitsPerLine) {
		const lineAddr = address + BigInt(unitOffset * unitSize);
		const values: string[] = [];
		for (let i = 0; i < unitsPerLine && unitOffset + i < count; i++) {
			const byteOff = (unitOffset + i) * unitSize;
			if (byteOff + unitSize > data.length) {
				values.push(missingUnit);
				continue;
			}
			let val: bigint;
			if (unitSize === 2) {
				val = BigInt(view.getUint16(byteOff, true));
			} else if (unitSize === 4) {
				val = BigInt(view.getUint32(byteOff, true));
			} else {
				val = view.getBigUint64(byteOff, true);
			}
			values.push(fmtHex(val, unitSize * 2).toLowerCase());
		}
		lines.push(`${fmtHex(lineAddr, 16).toLowerCase()}  ${values.join(" ")}`);
	}
	return { lines };
}
