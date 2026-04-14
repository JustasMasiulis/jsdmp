import type { WalkStackResult } from "../amd64_unwinder";
import type { CommandOutput } from "../commandEngine";
import { Amd64Context, Arm64Context } from "../cpu_context";
import { fmtHex } from "../formatting";
import type { MinidumpDebugInterface } from "../minidump_debug_interface";
import { resolveSymbol } from "../symbolication";

export async function stackCommand(
	dbg: MinidumpDebugInterface,
): Promise<CommandOutput> {
	const ctx = dbg.currentContext.state;
	if (!ctx) {
		return { lines: ["No thread context available"], isError: true };
	}

	try {
		const modules = dbg.modules.state;
		const reader = (addr: bigint, size: number) => dbg.read(addr, size);

		let result: WalkStackResult;
		if (ctx instanceof Amd64Context) {
			const { walkStack } = await import("../amd64_unwinder");
			result = await walkStack(reader, modules, ctx.clone(), 64);
		} else if (ctx instanceof Arm64Context) {
			const { arm64WalkStack } = await import("../arm64_unwinder");
			result = await arm64WalkStack(reader, modules, ctx.clone(), 64);
		} else {
			return {
				lines: ["Stack walking is not supported for this architecture"],
				isError: true,
			};
		}

		const lines: string[] = [];
		lines.push(" # Child-SP          RetAddr           Call Site");
		for (let i = 0; i < result.frames.length; i++) {
			const f = result.frames[i];
			const idx = String(i).padStart(2, "0");
			const sp = fmtHex(f.sp, 16).toLowerCase();
			const retAddr =
				i + 1 < result.frames.length ? result.frames[i + 1].ip : 0n;
			const ret = fmtHex(retAddr, 16).toLowerCase();
			const site = await resolveSymbol(f.ip, modules);
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
