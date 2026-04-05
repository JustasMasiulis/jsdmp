import type { CommandOutput } from "../commandEngine";
import {
	ARM64_GPR_NAMES,
	Arm64Context,
	type Context,
	GPR_NAMES,
} from "../cpu_context";
import { fmtHex } from "../formatting";
import type { MinidumpDebugInterface } from "../minidump_debug_interface";

const fmtReg = (name: string, value: bigint): string =>
	`${name.padStart(3)}=${fmtHex(value, 16).toLowerCase()}`;

function formatAmd64Registers(ctx: Context): string[] {
	const gpr = (idx: number) => fmtReg(GPR_NAMES[idx], ctx.gpr(idx));

	const lines: string[] = [];
	lines.push(`${gpr(0)} ${gpr(3)} ${gpr(1)}`);
	lines.push(`${gpr(2)} ${gpr(6)} ${gpr(7)}`);
	lines.push(`${fmtReg("rip", ctx.ip)} ${gpr(4)} ${gpr(5)}`);
	lines.push(`${gpr(8)} ${gpr(9)} ${gpr(10)}`);
	lines.push(`${gpr(11)} ${gpr(12)} ${gpr(13)}`);
	lines.push(`${gpr(14)} ${gpr(15)}`);
	const iopl = (ctx.flags >> 12) & 3;
	lines.push(`iopl=${iopl} efl=${fmtHex(ctx.flags, 8).toLowerCase()}`);
	return lines;
}

function formatArm64Registers(ctx: Arm64Context): string[] {
	const gpr = (idx: number) => fmtReg(ARM64_GPR_NAMES[idx], ctx.gpr(idx));

	const lines: string[] = [];
	for (let i = 0; i < 29; i += 4) {
		const row = [];
		for (let j = i; j < Math.min(i + 4, 29); j++) row.push(gpr(j));
		lines.push(row.join(" "));
	}
	lines.push(`${gpr(29)} ${gpr(30)}`);
	lines.push(`${fmtReg(" sp", ctx.sp)} ${fmtReg(" pc", ctx.ip)}`);
	lines.push(`cpsr=${fmtHex(ctx.cpsr, 8).toLowerCase()}`);
	return lines;
}

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

	const lines =
		ctx instanceof Arm64Context
			? formatArm64Registers(ctx)
			: formatAmd64Registers(ctx as Context);

	return Promise.resolve({ lines });
}
