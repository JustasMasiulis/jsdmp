import type { CommandOutput } from "../commandEngine";
import { fmtHex } from "../formatting";
import type { MinidumpDebugInterface } from "../minidump_debug_interface";
import { basename } from "../utils";

export function listModulesCommand(
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
