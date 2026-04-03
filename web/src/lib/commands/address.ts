import type { CommandOutput } from "../commandEngine";
import { evaluateExpression } from "../commandExpr";
import { findModuleForAddress } from "../debug_interface";
import { fmtHex } from "../formatting";
import type { MinidumpDebugInterface } from "../minidump_debug_interface";
import { resolveSymbol } from "../symbolication";
import { basename } from "../utils";

export async function addressCommand(
	dbg: MinidumpDebugInterface,
	args: string,
): Promise<CommandOutput> {
	const trimmed = args.trim();
	if (!trimmed) {
		return { lines: ["Address expression required"], isError: true };
	}

	const address = evaluateExpression(trimmed, dbg.currentContext.state);
	const ranges = dbg.memoryRanges.state;
	const modules = dbg.modules.state;

	let rangeBase = 0n;
	let rangeEnd = 0n;
	let rangeSize = 0n;
	let found = false;

	for (const range of ranges) {
		if (address >= range.address && address < range.address + range.size) {
			rangeBase = range.address;
			rangeSize = range.size;
			rangeEnd = range.address + range.size;
			found = true;
			break;
		}
	}

	const mod = findModuleForAddress(address, modules);
	const moduleName = mod ? basename(mod.path) : "<unknown>";
	const symbol = await resolveSymbol(address, modules);

	if (!found) {
		return {
			lines: [
				`Address ${fmtHex(address, 16).toLowerCase()} not found in any memory range`,
				`Symbol:        ${symbol}`,
				mod ? `Module: ${moduleName}` : "",
			].filter(Boolean),
			isError: !mod,
		};
	}

	const lines = [
		`Base Address:  ${fmtHex(rangeBase, 16).toLowerCase()}`,
		`End Address:   ${fmtHex(rangeEnd, 16).toLowerCase()}`,
		`Region Size:   ${fmtHex(rangeSize, 16).toLowerCase()}`,
		`Symbol:        ${symbol}`,
		`Module:        ${moduleName}`,
	];
	return { lines };
}
