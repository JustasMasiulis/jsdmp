import type { CommandOutput } from "../commandEngine";
import { GPR_NAMES } from "../cpu_context";
import { fmtHex } from "../formatting";
import type { MinidumpDebugInterface } from "../minidump_debug_interface";

export function registerCommand(
	dbg: MinidumpDebugInterface,
): Promise<CommandOutput> {
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
	lines.push(`${gpr(0)} ${gpr(3)} ${gpr(1)}`);
	lines.push(`${gpr(2)} ${gpr(6)} ${gpr(7)}`);
	lines.push(`${reg("rip", ctx.ip)} ${gpr(4)} ${gpr(5)}`);
	lines.push(`${gpr(8)} ${gpr(9)} ${gpr(10)}`);
	lines.push(`${gpr(11)} ${gpr(12)} ${gpr(13)}`);
	lines.push(`${gpr(14)} ${gpr(15)}`);
	const iopl = (ctx.flags >> 12) & 3;
	lines.push(`iopl=${iopl} efl=${fmtHex(ctx.flags, 8).toLowerCase()}`);

	return Promise.resolve({ lines });
}
