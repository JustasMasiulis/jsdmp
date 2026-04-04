import { evaluateExpression } from "./commandExpr";
import { addressCommand } from "./commands/address";
import { unassembleCommand } from "./commands/disassemble";
import { dpsCommand } from "./commands/dps";
import { evaluateCommand } from "./commands/evaluate";
import { exceptionRecordCommand } from "./commands/exception";
import { fnentCommand } from "./commands/fnent";
import { displayBytesCommand, displayWordsCommand } from "./commands/memory";
import { listModulesCommand } from "./commands/modules";
import { registerCommand } from "./commands/register";
import { stackCommand } from "./commands/stack";
import { threadsCommand } from "./commands/threads";
import type { Context } from "./cpu_context";
import type { InstrTextSegment } from "./disassembly";
import type { MinidumpDebugInterface } from "./minidump_debug_interface";

export type CommandOutputLine = string | InstrTextSegment[];

export type CommandOutput = {
	lines: CommandOutputLine[];
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

export function parseAddressAndCount(
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
			name: "dps",
			aliases: ["dpp", "dpa"],
			summary: "Display pointer-sized values with symbols",
			execute: (ctx) => dpsCommand(dbg, ctx.args),
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
			name: ".fnent",
			aliases: [],
			summary: "Display function entry unwind info",
			execute: (ctx) => fnentCommand(dbg, ctx.args),
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

			let matched: CommandHandler | undefined;
			let args = "";

			for (const [name, handler] of registry) {
				if (
					trimmed.startsWith(name) &&
					(!matched || name.length > matched.name.length)
				) {
					const rest = trimmed.slice(name.length);
					if (rest === "" || rest[0] === " " || name === "~" || name === "?") {
						matched = handler;
						args = rest.trimStart();
					}
				}
			}

			if (!matched) {
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
