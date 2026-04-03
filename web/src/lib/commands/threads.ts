import type { CommandOutput } from "../commandEngine";
import { fmtHex } from "../formatting";
import type { MinidumpDebugInterface } from "../minidump_debug_interface";

export function threadsCommand(
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
