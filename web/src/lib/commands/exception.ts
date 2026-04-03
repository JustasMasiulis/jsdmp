import type { CommandOutput } from "../commandEngine";
import { fmtHex } from "../formatting";
import type { MinidumpDebugInterface } from "../minidump_debug_interface";

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

export function exceptionRecordCommand(
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
