import type { MinidumpDebugInterface } from "./minidump_debug_interface";

// biome-ignore lint/style/noNonNullAssertion: set by WasmDumpDebugger before layout mounts
export let DBG: MinidumpDebugInterface = null!;

export function setDBG(di: MinidumpDebugInterface): void {
	DBG = di;
}
