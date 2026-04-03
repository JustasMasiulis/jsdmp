import {
	type CommandOutput,
	type CommandOutputLine,
	parseAddressAndCount,
} from "../commandEngine";
import {
	decodeInstruction,
	type InstrTextSegment,
	MAX_INSTRUCTION_LENGTH,
	seg,
} from "../disassembly";
import { fmtHex } from "../formatting";
import type { MinidumpDebugInterface } from "../minidump_debug_interface";
import { resolveSymbol } from "../symbolication";

export async function unassembleCommand(
	dbg: MinidumpDebugInterface,
	args: string,
): Promise<CommandOutput> {
	const ctx = dbg.currentContext.state;
	if (!ctx && !args.trim()) {
		return { lines: ["No thread context available"], isError: true };
	}
	const { address, count } = parseAddressAndCount(args, ctx, 8, ctx?.ip);

	const lines: CommandOutputLine[] = [];
	const symbolLabel = await resolveSymbol(address, dbg.modules.state);
	lines.push(`${symbolLabel}:`);
	let currentAddr = address;

	for (let i = 0; i < count; i++) {
		let bytes: Uint8Array;
		try {
			bytes = await dbg.read(currentAddr, MAX_INSTRUCTION_LENGTH, 1);
		} catch {
			lines.push(fmtHex(currentAddr, 16).toLowerCase() + " ??");
			break;
		}

		const instr = decodeInstruction(bytes, currentAddr);
		if (!instr) {
			lines.push(fmtHex(currentAddr, 16).toLowerCase() + " ??");
			break;
		}

		const hexBytes = Array.from(instr.bytes)
			.map((b) => fmtHex(b, 2).toLowerCase())
			.join("");
		const prefixedMnemonic = instr.prefix
			? instr.prefix + " " + instr.mnemonic
			: instr.mnemonic;

		const line: InstrTextSegment[] = [
			seg(fmtHex(currentAddr, 16).toLowerCase() + " "),
			seg(hexBytes.padEnd(16) + " "),
			seg(prefixedMnemonic.padEnd(8) + " ", "mnemonic"),
			...instr.operandSegments,
		];
		lines.push(line);
		currentAddr += BigInt(instr.length);
	}
	return { lines };
}
