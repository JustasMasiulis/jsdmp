import type { CommandOutput } from "../commandEngine";
import { evaluateExpression } from "../commandExpr";
import { fmtHex } from "../formatting";
import type { MinidumpDebugInterface } from "../minidump_debug_interface";

export function evaluateCommand(
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
