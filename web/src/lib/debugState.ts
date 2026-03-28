import type { ResolvedDumpContext } from "./context";
import type { MinidumpDebugInterface } from "./minidump_debug_interface";

// biome-ignore lint/style/noNonNullAssertion: debugInterface is set by the WasmDumpDebugger
export let DBG: MinidumpDebugInterface = null!;
export let resolvedContext: ResolvedDumpContext | null = null;

export function setDebugInterface(di: MinidumpDebugInterface): void {
	DBG = di;
}

export function setResolvedContext(ctx: ResolvedDumpContext | null): void {
	resolvedContext = ctx;
}
