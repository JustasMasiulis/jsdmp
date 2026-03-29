import { evaluateExpression } from "./commandExpr";
import type { Context } from "./cpu_context";
import { disassembleInstruction, MAX_INSTRUCTION_LENGTH } from "./disassembly";
import { fmtHex, fmtHex16 } from "./formatting";
import type { MinidumpDebugInterface } from "./minidump_debug_interface";
import { basename } from "./utils";

type CommandOutput = {
	lines: string[];
	isError?: boolean;
};

type CommandContext = {
	dbg: MinidumpDebugInterface;
	args: string;
};

type CommandHandler = {
	name: string;
	aliases: string[];
	summary: string;
	execute: (ctx: CommandContext) => Promise<CommandOutput>;
};

export type CommandEngine = {
	execute: (input: string) => Promise<CommandOutput>;
	getCommands: () => CommandHandler[];
};

function resolveModuleForAddress(
	address: bigint,
	modules: Array<{ address: bigint; size: number; path: string }>,
): {
	module: { address: bigint; size: number; path: string };
	offset: bigint;
} | null {
	for (const mod of modules) {
		if (address >= mod.address && address < mod.address + BigInt(mod.size)) {
			return { module: mod, offset: address - mod.address };
		}
	}
	return null;
}

function formatModuleOffset(
	address: bigint,
	modules: Array<{ address: bigint; size: number; path: string }>,
): string {
	const resolved = resolveModuleForAddress(address, modules);
	if (resolved) {
		return `${basename(resolved.module.path)}+0x${resolved.offset.toString(16)}`;
	}
	return fmtHex16(address);
}

const GPR_NAMES = [
	"rax",
	"rcx",
	"rdx",
	"rbx",
	"rsp",
	"rbp",
	"rsi",
	"rdi",
	"r8",
	"r9",
	"r10",
	"r11",
	"r12",
	"r13",
	"r14",
	"r15",
];

function registerCommand(dbg: MinidumpDebugInterface): Promise<CommandOutput> {
	const ctx = dbg.currentContext.state;
	if (!ctx) {
		return Promise.resolve({
			lines: ["No thread context available"],
			isError: true,
		});
	}

	const reg = (name: string, value: bigint): string =>
		`${name.padStart(3)}=${fmtHex(value, 16).toLowerCase()}`;

	const gpr = (idx: number) => reg(GPR_NAMES[idx], ctx.gpr(idx));

	const lines: string[] = [];
	// rax(0), rbx(3), rcx(1)
	lines.push(`${gpr(0)} ${gpr(3)} ${gpr(1)}`);
	// rdx(2), rsi(6), rdi(7)
	lines.push(`${gpr(2)} ${gpr(6)} ${gpr(7)}`);
	// rip, rsp(4), rbp(5)
	lines.push(`${reg("rip", ctx.ip)} ${gpr(4)} ${gpr(5)}`);
	// r8-r10
	lines.push(`${gpr(8)} ${gpr(9)} ${gpr(10)}`);
	// r11-r13
	lines.push(`${gpr(11)} ${gpr(12)} ${gpr(13)}`);
	// r14-r15
	lines.push(`${gpr(14)} ${gpr(15)}`);
	// flags
	const iopl = (ctx.flags >> 12) & 3;
	lines.push(`iopl=${iopl} efl=${fmtHex(ctx.flags, 8).toLowerCase()}`);

	return Promise.resolve({ lines });
}

function threadsCommand(
	dbg: MinidumpDebugInterface,
	args: string,
): Promise<CommandOutput> {
	const threads = dbg.threads.state;
	const current = dbg.currentThread.state;
	const trimmed = args.trim();

	if (!trimmed) {
		const lines = threads.map((t, i) => {
			const marker = t === current ? "." : " ";
			return `${marker} ${String(i).padStart(2)}  Id: ${fmtHex(t.id, 4).toLowerCase()} Suspend: ${t.suspendCount} Teb: ${fmtHex(t.teb, 16).toLowerCase()}`;
		});
		return Promise.resolve({ lines });
	}

	const match = trimmed.match(/^(\d+)(s)?$/);
	if (!match) {
		return Promise.resolve({
			lines: [`Invalid thread syntax: '${trimmed}'`],
			isError: true,
		});
	}

	const idx = Number.parseInt(match[1], 10);
	if (idx < 0 || idx >= threads.length) {
		return Promise.resolve({
			lines: [`Thread index ${idx} out of range (0-${threads.length - 1})`],
			isError: true,
		});
	}

	const thread = threads[idx];
	if (match[2] === "s") {
		dbg.selectThread(thread);
		return Promise.resolve({
			lines: [
				`Switched to thread ${idx} (Id: ${fmtHex(thread.id, 4).toLowerCase()})`,
			],
		});
	}

	const lines = [
		`Thread ${idx}:`,
		`  Id: ${fmtHex(thread.id, 4).toLowerCase()}`,
		`  Suspend: ${thread.suspendCount}`,
		`  Teb: ${fmtHex(thread.teb, 16).toLowerCase()}`,
		`  Priority: ${thread.priority}`,
	];
	return Promise.resolve({ lines });
}

async function stackCommand(
	dbg: MinidumpDebugInterface,
): Promise<CommandOutput> {
	const ctx = dbg.currentContext.state;
	if (!ctx) {
		return { lines: ["No thread context available"], isError: true };
	}

	try {
		const { walkStack, contextFromCpuContext } = await import("./unwinder");
		const modules = dbg.modules.state;
		const reader = (addr: bigint, size: number) => dbg.read(addr, size);
		const result = await walkStack(
			reader,
			modules,
			contextFromCpuContext(ctx),
			64,
		);

		const lines: string[] = [];
		lines.push(" # Child-SP          RetAddr           Call Site");
		for (let i = 0; i < result.frames.length; i++) {
			const f = result.frames[i];
			const idx = String(i).padStart(2, "0");
			const sp = fmtHex(f.sp, 16).toLowerCase();
			const retAddr =
				i + 1 < result.frames.length ? result.frames[i + 1].ip : 0n;
			const ret = fmtHex(retAddr, 16).toLowerCase();
			const site = formatModuleOffset(f.ip, modules);
			lines.push(`${idx} ${sp}  ${ret}  ${site}`);
		}
		if (result.error) {
			lines.push(`Stack walk incomplete: ${result.error}`);
		}
		return { lines };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return {
			lines: [`Stack walk failed: ${msg}`],
			isError: true,
		};
	}
}

function listModulesCommand(
	dbg: MinidumpDebugInterface,
): Promise<CommandOutput> {
	const modules = dbg.modules.state;
	const unloaded = dbg.unloadedModules.state;
	const lines: string[] = [];

	lines.push("start             end                 module name");
	for (const mod of modules) {
		const start = fmtHex(mod.address, 16).toLowerCase();
		const end = fmtHex(mod.address + BigInt(mod.size), 16).toLowerCase();
		lines.push(`${start}  ${end}    ${basename(mod.path)}`);
	}

	if (unloaded.length > 0) {
		lines.push("");
		lines.push("Unloaded modules:");
		lines.push("start             end                 module name");
		for (const mod of unloaded) {
			const start = fmtHex(mod.address, 16).toLowerCase();
			const end = fmtHex(mod.address + BigInt(mod.size), 16).toLowerCase();
			lines.push(`${start}  ${end}    ${basename(mod.path)}`);
		}
	}

	return Promise.resolve({ lines });
}

function parseAddressAndCount(
	args: string,
	ctx: Context | null,
	defaultCount: number,
	defaultAddress?: bigint,
): { address: bigint; count: number } {
	const trimmed = args.trim();
	const countMatch = trimmed.match(/\bL(\d+)\s*$/i);
	let count = defaultCount;
	let addrStr = trimmed;
	if (countMatch) {
		count = Number.parseInt(countMatch[1], 10);
		addrStr = trimmed.slice(0, countMatch.index).trim();
	}
	if (!addrStr) {
		if (defaultAddress !== undefined) return { address: defaultAddress, count };
		throw new Error("Address expression required");
	}
	const address = evaluateExpression(addrStr, ctx);
	return { address, count };
}

async function displayBytesCommand(
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
			lines: [
				`Memory read failed at ${fmtHex(address, 16).toLowerCase()}`,
			],
			isError: true,
		};
	}

	const lines: string[] = [];
	// Iterate over the full requested range, showing ?? for bytes beyond what we got
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

async function displayWordsCommand(
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
			lines: [
				`Memory read failed at ${fmtHex(address, 16).toLowerCase()}`,
			],
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

async function unassembleCommand(
	dbg: MinidumpDebugInterface,
	args: string,
): Promise<CommandOutput> {
	const ctx = dbg.currentContext.state;
	if (!ctx && !args.trim()) {
		return { lines: ["No thread context available"], isError: true };
	}
	const { address, count } = parseAddressAndCount(args, ctx, 8, ctx?.ip);

	const lines: string[] = [];
	let currentAddr = address;

	for (let i = 0; i < count; i++) {
		let bytes: Uint8Array;
		try {
			bytes = await dbg.read(currentAddr, MAX_INSTRUCTION_LENGTH, 1);
		} catch {
			lines.push(`${fmtHex(currentAddr, 16).toLowerCase()} ??`);
			break;
		}

		const instr = disassembleInstruction(bytes, currentAddr);
		if (!instr) {
			lines.push(`${fmtHex(currentAddr, 16).toLowerCase()} ??`);
			break;
		}

		const hexBytes = Array.from(instr.bytes)
			.map((b) => fmtHex(b, 2).toLowerCase())
			.join("");
		const mnemonic = instr.mnemonic.padEnd(8);
		lines.push(
			`${fmtHex(currentAddr, 16).toLowerCase()} ${hexBytes.padEnd(16)} ${mnemonic}${instr.operands}`,
		);
		currentAddr += BigInt(instr.length);
	}
	return { lines };
}

function addressCommand(
	dbg: MinidumpDebugInterface,
	args: string,
): Promise<CommandOutput> {
	const trimmed = args.trim();
	if (!trimmed) {
		return Promise.resolve({
			lines: ["Address expression required"],
			isError: true,
		});
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

	const resolved = resolveModuleForAddress(address, modules);
	const moduleName = resolved ? basename(resolved.module.path) : "<unknown>";

	if (!found) {
		return Promise.resolve({
			lines: [
				`Address ${fmtHex(address, 16).toLowerCase()} not found in any memory range`,
				resolved ? `Module: ${moduleName}` : "",
			].filter(Boolean),
			isError: !resolved,
		});
	}

	const lines = [
		`Base Address:  ${fmtHex(rangeBase, 16).toLowerCase()}`,
		`End Address:   ${fmtHex(rangeEnd, 16).toLowerCase()}`,
		`Region Size:   ${fmtHex(rangeSize, 16).toLowerCase()}`,
		`Module:        ${moduleName}`,
	];
	return Promise.resolve({ lines });
}

const EXCEPTION_NAMES: Record<number, string> = {
	3221225477: "Access violation",
	3221225725: "Stack overflow",
	2147483651: "Breakpoint",
	2147483652: "Single step",
	3221225620: "Integer divide by zero",
	3221225622: "Privileged instruction",
	3221225501: "Illegal instruction",
	3221225509: "Noncontinuable exception",
};

function exceptionRecordCommand(
	dbg: MinidumpDebugInterface,
): Promise<CommandOutput> {
	const info = dbg.exceptionInfo;
	if (!info) {
		return Promise.resolve({
			lines: ["No exception record available"],
			isError: true,
		});
	}

	const rec = info.exceptionRecord;
	const codeName = EXCEPTION_NAMES[rec.exceptionCode] ?? "Unknown";
	const lines = [
		`ExceptionAddress: ${fmtHex(rec.exceptionAddress, 16).toLowerCase()}`,
		`   ExceptionCode: ${fmtHex(rec.exceptionCode, 8).toLowerCase()} (${codeName})`,
		`  ExceptionFlags: ${fmtHex(rec.exceptionFlags, 8).toLowerCase()}`,
		`NumberParameters: ${rec.numberParameters}`,
	];

	for (let i = 0; i < rec.exceptionInformation.length; i++) {
		lines.push(
			`   Parameter[${i}]: ${fmtHex(rec.exceptionInformation[i], 16).toLowerCase()}`,
		);
	}

	return Promise.resolve({ lines });
}

function evaluateCommand(
	dbg: MinidumpDebugInterface,
	args: string,
): Promise<CommandOutput> {
	const trimmed = args.trim();
	if (!trimmed) {
		return Promise.resolve({
			lines: ["Expression required"],
			isError: true,
		});
	}

	const value = evaluateExpression(trimmed, dbg.currentContext.state);
	const decimal = value.toString(10);
	const hex = fmtHex(value, 16).toLowerCase();
	return Promise.resolve({
		lines: [`Evaluate expression: ${decimal} = ${hex}`],
	});
}

export function createCommandEngine(
	dbg: MinidumpDebugInterface,
): CommandEngine {
	const commands: CommandHandler[] = [
		{
			name: "r",
			aliases: [],
			summary: "Display registers",
			execute: () => registerCommand(dbg),
		},
		{
			name: "~",
			aliases: [],
			summary: "List/switch threads",
			execute: (ctx) => threadsCommand(dbg, ctx.args),
		},
		{
			name: "k",
			aliases: [],
			summary: "Display call stack",
			execute: () => stackCommand(dbg),
		},
		{
			name: "lm",
			aliases: [],
			summary: "List loaded modules",
			execute: () => listModulesCommand(dbg),
		},
		{
			name: "db",
			aliases: [],
			summary: "Display memory as bytes",
			execute: (ctx) => displayBytesCommand(dbg, ctx.args),
		},
		{
			name: "dw",
			aliases: [],
			summary: "Display memory as words",
			execute: (ctx) => displayWordsCommand(dbg, ctx.args, 2, 8, 64),
		},
		{
			name: "dd",
			aliases: [],
			summary: "Display memory as dwords",
			execute: (ctx) => displayWordsCommand(dbg, ctx.args, 4, 4, 32),
		},
		{
			name: "dq",
			aliases: ["dp"],
			summary: "Display memory as qwords",
			execute: (ctx) => displayWordsCommand(dbg, ctx.args, 8, 2, 16),
		},
		{
			name: "u",
			aliases: [],
			summary: "Unassemble (disassemble)",
			execute: (ctx) => unassembleCommand(dbg, ctx.args),
		},
		{
			name: "!address",
			aliases: [],
			summary: "Show address information",
			execute: (ctx) => addressCommand(dbg, ctx.args),
		},
		{
			name: ".exr",
			aliases: [],
			summary: "Display exception record",
			execute: () => exceptionRecordCommand(dbg),
		},
		{
			name: "?",
			aliases: [],
			summary: "Evaluate expression",
			execute: (ctx) => evaluateCommand(dbg, ctx.args),
		},
		{
			name: ".help",
			aliases: [],
			summary: "Show available commands",
			execute: () => {
				const lines: string[] = [];
				lines.push(`${"Command".padEnd(11)}${"Aliases".padEnd(9)}Description`);
				for (const cmd of commands) {
					const aliases = cmd.aliases.join(", ");
					lines.push(
						`${cmd.name.padEnd(11)}${aliases.padEnd(9)}${cmd.summary}`,
					);
				}
				return Promise.resolve({ lines });
			},
		},
	];

	const registry = new Map<string, CommandHandler>();
	for (const cmd of commands) {
		registry.set(cmd.name, cmd);
		for (const alias of cmd.aliases) {
			registry.set(alias, cmd);
		}
	}

	return {
		execute: async (input: string): Promise<CommandOutput> => {
			const trimmed = input.trim();
			if (!trimmed) {
				return { lines: [] };
			}

			// Try longest prefix match for commands with special chars
			let matched: CommandHandler | undefined;
			let args = "";

			for (const [name, handler] of registry) {
				if (
					trimmed.startsWith(name) &&
					(!matched || name.length > matched.name.length)
				) {
					// Ensure the match is at a word boundary or end of string
					const rest = trimmed.slice(name.length);
					if (
						rest === "" ||
						rest[0] === " " ||
						// Allow digits after ~ for thread commands
						name === "~" ||
						// Allow any suffix for ? (evaluate)
						name === "?"
					) {
						matched = handler;
						args = rest.trimStart();
					}
				}
			}

			if (!matched) {
				// Fallback: split on first whitespace
				const spaceIdx = trimmed.indexOf(" ");
				const cmdName = spaceIdx >= 0 ? trimmed.slice(0, spaceIdx) : trimmed;
				const cmdArgs = spaceIdx >= 0 ? trimmed.slice(spaceIdx + 1).trim() : "";

				const handler = registry.get(cmdName);
				if (handler) {
					matched = handler;
					args = cmdArgs;
				}
			}

			if (!matched) {
				return {
					lines: [`Unknown command: '${trimmed.split(/\s/)[0]}'`],
					isError: true,
				};
			}

			try {
				return await matched.execute({ dbg, args });
			} catch (e) {
				const message = e instanceof Error ? e.message : String(e);
				return { lines: [message], isError: true };
			}
		},
		getCommands: () => [...commands],
	};
}
