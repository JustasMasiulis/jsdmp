import { type CommandOutput, parseAddressAndCount } from "../commandEngine";
import { evaluateExpression } from "../commandExpr";
import { fmtHex } from "../formatting";
import type { MinidumpDebugInterface } from "../minidump_debug_interface";
import { resolveSymbol } from "../symbolication";

const POINTER_SIZE = 8;
const DEFAULT_COUNT = 16;
const MAX_COUNT = 4096;

function parseAddressRange(
	args: string,
	dbg: MinidumpDebugInterface,
): { address: bigint; count: number } {
	const trimmed = args.trim();
	const ctx = dbg.currentContext.state;

	if (/\bL\d+\s*$/i.test(trimmed)) {
		return parseAddressAndCount(trimmed, ctx, DEFAULT_COUNT);
	}

	const parts = trimmed.split(/\s+/);
	if (parts.length >= 2) {
		try {
			const startAddr = evaluateExpression(parts[0], ctx);
			const endAddr = evaluateExpression(parts.slice(1).join(" "), ctx);
			if (endAddr > startAddr) {
				const byteRange = Number(endAddr - startAddr);
				return {
					address: startAddr,
					count: Math.ceil(byteRange / POINTER_SIZE),
				};
			}
		} catch {}
	}

	return parseAddressAndCount(trimmed, ctx, DEFAULT_COUNT);
}

export async function dpsCommand(
	dbg: MinidumpDebugInterface,
	args: string,
): Promise<CommandOutput> {
	const parsed = parseAddressRange(args, dbg);
	const count = Math.min(parsed.count, MAX_COUNT);
	const address = parsed.address;
	const totalBytes = count * POINTER_SIZE;

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
	const modules = dbg.modules.state;

	type Entry = { lineAddr: bigint; pointerValue: bigint | null };
	const entries: Entry[] = [];
	for (let i = 0; i < count; i++) {
		const byteOffset = i * POINTER_SIZE;
		const lineAddr = address + BigInt(byteOffset);
		const pointerValue =
			byteOffset + POINTER_SIZE <= data.length
				? view.getBigUint64(byteOffset, true)
				: null;
		entries.push({ lineAddr, pointerValue });
	}

	const symbols = await Promise.all(
		entries.map((e) =>
			e.pointerValue !== null
				? resolveSymbol(e.pointerValue, modules)
				: Promise.resolve(null),
		),
	);

	const lines: string[] = entries.map((e, i) => {
		const addrStr = fmtHex(e.lineAddr, 16).toLowerCase();
		if (e.pointerValue === null) {
			return `${addrStr}  ????????????????`;
		}
		const valueStr = fmtHex(e.pointerValue, 16).toLowerCase();
		const sym = symbols[i];
		return sym && sym !== valueStr
			? `${addrStr}  ${valueStr}  ${sym}`
			: `${addrStr}  ${valueStr}`;
	});

	return { lines };
}
