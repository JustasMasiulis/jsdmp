import {
	UWOP_ALLOC_LARGE,
	UWOP_ALLOC_SMALL,
	UWOP_EPILOG,
	UWOP_PUSH_MACHFRAME,
	UWOP_PUSH_NONVOL,
	UWOP_SAVE_NONVOL,
	UWOP_SAVE_NONVOL_FAR,
	UWOP_SAVE_XMM128,
	UWOP_SAVE_XMM128_FAR,
	UWOP_SET_FPREG,
	unwindOpSlots,
} from "../amd64_unwinder";
import { type CommandOutput, parseAddressAndCount } from "../commandEngine";
import { AMD64_GPR_NAMES } from "../cpu_context";
import { findModuleForAddress } from "../debug_interface";
import { fmtHex } from "../formatting";
import type { MinidumpDebugInterface } from "../minidump_debug_interface";
import {
	type RuntimeFunction,
	readUnwindInfo,
	UNW_FLAG_CHAININFO,
	type UnwindCode,
	type UnwindInfo,
} from "../pe";
import { resolveSymbol } from "../symbolication";
import { getModulePeFile } from "../symbolServer";
import { basename } from "../utils";

function formatUnwindFlags(flags: number): string {
	const names: string[] = [];
	if (flags & 0x01) names.push("EHANDLER");
	if (flags & 0x02) names.push("UHANDLER");
	if (flags & 0x04) names.push("CHAININFO");
	if (names.length === 0) return "0x00";
	return `0x${fmtHex(flags, 2).toLowerCase()} (${names.join(" | ")})`;
}

function formatUwop(
	code: UnwindCode,
	codes: UnwindCode[],
	index: number,
	info: UnwindInfo,
): string {
	switch (code.unwindOp) {
		case UWOP_PUSH_NONVOL:
			return `PUSH_NONVOL ${AMD64_GPR_NAMES[code.opInfo]}`;
		case UWOP_ALLOC_SMALL:
			return `ALLOC_SMALL 0x${fmtHex(code.opInfo * 8 + 8, 2).toLowerCase()}`;
		case UWOP_ALLOC_LARGE:
			if (code.opInfo === 0) {
				return `ALLOC_LARGE 0x${fmtHex(codes[index + 1].frameOffset * 8, 1).toLowerCase()}`;
			}
			return `ALLOC_LARGE 0x${fmtHex(((codes[index + 2].frameOffset << 16) | codes[index + 1].frameOffset) >>> 0, 1).toLowerCase()}`;
		case UWOP_SET_FPREG:
			return `SET_FPREG ${AMD64_GPR_NAMES[info.frameRegister]}`;
		case UWOP_SAVE_NONVOL:
			return `SAVE_NONVOL ${AMD64_GPR_NAMES[code.opInfo]} at 0x${fmtHex(codes[index + 1].frameOffset * 8, 1).toLowerCase()}`;
		case UWOP_SAVE_NONVOL_FAR:
			return `SAVE_NONVOL_FAR ${AMD64_GPR_NAMES[code.opInfo]} at 0x${fmtHex(((codes[index + 2].frameOffset << 16) | codes[index + 1].frameOffset) >>> 0, 1).toLowerCase()}`;
		case UWOP_EPILOG:
			return "EPILOG";
		case UWOP_SAVE_XMM128:
			return `SAVE_XMM128 xmm${code.opInfo} at 0x${fmtHex(codes[index + 1].frameOffset * 16, 1).toLowerCase()}`;
		case UWOP_SAVE_XMM128_FAR:
			return `SAVE_XMM128_FAR xmm${code.opInfo} at 0x${fmtHex(((codes[index + 2].frameOffset << 16) | codes[index + 1].frameOffset) >>> 0, 1).toLowerCase()}`;
		case UWOP_PUSH_MACHFRAME:
			return code.opInfo !== 0
				? "PUSH_MACHFRAME (error code)"
				: "PUSH_MACHFRAME";
		default:
			return `UNKNOWN_OP(${code.unwindOp})`;
	}
}

function formatFunctionEntry(
	entry: RuntimeFunction,
	info: UnwindInfo,
	lines: string[],
): void {
	lines.push(
		`  BeginAddress      = 0x${fmtHex(entry.beginAddress, 8).toLowerCase()}`,
	);
	lines.push(
		`  EndAddress        = 0x${fmtHex(entry.endAddress, 8).toLowerCase()}`,
	);
	lines.push(
		`  UnwindInfoAddress = 0x${fmtHex(entry.unwindInfoAddress, 8).toLowerCase()}`,
	);
	lines.push("");
	lines.push("  Unwind info:");
	lines.push(`    Version           ${info.version}`);
	lines.push(`    Flags             ${formatUnwindFlags(info.flags)}`);
	lines.push(
		`    SizeOfProlog      0x${fmtHex(info.sizeOfProlog, 2).toLowerCase()}`,
	);
	lines.push(`    CountOfCodes      ${info.countOfUnwindCodes}`);
	lines.push(
		`    FrameRegister     ${info.frameRegister !== 0 ? AMD64_GPR_NAMES[info.frameRegister] : "none"}`,
	);
	lines.push(
		`    FrameOffset       0x${fmtHex(info.frameOffset, 2).toLowerCase()}`,
	);

	if (info.unwindCodes.length > 0) {
		lines.push("");
		lines.push("    Unwind codes:");
		let i = 0;
		while (i < info.unwindCodes.length) {
			const c = info.unwindCodes[i];
			const desc = formatUwop(c, info.unwindCodes, i, info);
			lines.push(
				`      [${String(i).padStart(2)}] 0x${fmtHex(c.codeOffset, 2).toLowerCase()}: ${desc}`,
			);
			i += unwindOpSlots(c);
		}
	}

	if (info.flags & UNW_FLAG_CHAININFO && info.chainedFunctionEntry) {
		const ch = info.chainedFunctionEntry;
		lines.push("");
		lines.push(
			`    Chained to: 0x${fmtHex(ch.beginAddress, 8).toLowerCase()}..0x${fmtHex(ch.endAddress, 8).toLowerCase()}`,
		);
	}
}

export async function fnentCommand(
	dbg: MinidumpDebugInterface,
	args: string,
): Promise<CommandOutput> {
	const ctx = dbg.currentContext.state;
	const trimmed = args.trim();
	let address: bigint;
	if (!trimmed) {
		if (!ctx) return { lines: ["No thread context available"], isError: true };
		address = ctx.ip;
	} else {
		({ address } = parseAddressAndCount(trimmed, ctx, 1));
	}

	const mod = findModuleForAddress(address, dbg.modules.state);
	if (!mod)
		return {
			lines: [
				`No module found for address ${fmtHex(address, 16).toLowerCase()}`,
			],
			isError: true,
		};

	const pe = await getModulePeFile(mod);
	if (!pe)
		return {
			lines: [`Failed to load PE for ${basename(mod.path)}`],
			isError: true,
		};

	const reader = (addr: bigint, size: number) => dbg.read(addr, size);
	const rva = Number(address - mod.address);

	const exactEntry = await pe.findRuntimeFunction(reader, mod.address, rva);
	if (!exactEntry)
		return {
			lines: [
				`No function entry for ${fmtHex(address, 16).toLowerCase()} (leaf function)`,
			],
			isError: true,
		};

	const exactInfo = await readUnwindInfo(
		reader,
		mod.address,
		exactEntry.unwindInfoAddress,
	);
	if (!exactInfo)
		return { lines: ["Failed to read unwind info"], isError: true };

	let rootEntry = exactEntry;
	let rootInfo = exactInfo;
	let depth = 0;
	while (
		rootInfo.flags & UNW_FLAG_CHAININFO &&
		rootInfo.chainedFunctionEntry &&
		depth < 32
	) {
		rootEntry = rootInfo.chainedFunctionEntry;
		const nextInfo = await readUnwindInfo(
			reader,
			mod.address,
			rootEntry.unwindInfoAddress,
		);
		if (!nextInfo) break;
		rootInfo = nextInfo;
		depth++;
	}

	const allEntries = await pe.getAllRuntimeFunctions(reader, mod.address);

	const unwindInfoCache = new Map<number, UnwindInfo | null>();
	unwindInfoCache.set(exactEntry.unwindInfoAddress, exactInfo);
	unwindInfoCache.set(rootEntry.unwindInfoAddress, rootInfo);

	async function getCachedUnwindInfo(rva: number): Promise<UnwindInfo | null> {
		const cached = unwindInfoCache.get(rva);
		if (cached !== undefined) return cached;
		const info = await readUnwindInfo(reader, mod.address, rva);
		unwindInfoCache.set(rva, info);
		return info;
	}

	const children: { entry: RuntimeFunction; info: UnwindInfo }[] = [];
	for (const entry of allEntries) {
		if (entry.beginAddress === rootEntry.beginAddress) continue;

		const info = await getCachedUnwindInfo(entry.unwindInfoAddress);
		if (!info || !(info.flags & UNW_FLAG_CHAININFO)) continue;

		let current = info;
		let chainDepth = 0;
		while (
			current.flags & UNW_FLAG_CHAININFO &&
			current.chainedFunctionEntry &&
			chainDepth < 32
		) {
			if (
				current.chainedFunctionEntry.beginAddress === rootEntry.beginAddress
			) {
				children.push({ entry, info });
				break;
			}
			const next = await getCachedUnwindInfo(
				current.chainedFunctionEntry.unwindInfoAddress,
			);
			if (!next) break;
			current = next;
			chainDepth++;
		}
	}

	children.sort((a, b) => a.entry.beginAddress - b.entry.beginAddress);

	const lines: string[] = [];

	if (
		exactEntry.beginAddress !== rootEntry.beginAddress ||
		exactEntry.endAddress !== rootEntry.endAddress
	) {
		lines.push(
			`Address ${fmtHex(address, 16).toLowerCase()} is in entry 0x${fmtHex(exactEntry.beginAddress, 8).toLowerCase()}..0x${fmtHex(exactEntry.endAddress, 8).toLowerCase()}, which chains to root:`,
		);
		lines.push("");
	}

	const rootSymbol = await resolveSymbol(
		mod.address + BigInt(rootEntry.beginAddress),
		dbg.modules.state,
	);
	lines.push(`${rootSymbol}:`);
	formatFunctionEntry(rootEntry, rootInfo, lines);

	for (const child of children) {
		const childSymbol = await resolveSymbol(
			mod.address + BigInt(child.entry.beginAddress),
			dbg.modules.state,
		);
		lines.push("");
		lines.push(`Child entry ${childSymbol}:`);
		formatFunctionEntry(child.entry, child.info, lines);
	}

	return { lines };
}
