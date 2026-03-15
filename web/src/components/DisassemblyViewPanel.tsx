import { createEffect, onCleanup, onMount } from "solid-js";
import type { ParsedDumpInfo } from "./DumpSummary";
import { VanillaDisassemblyView } from "./VanillaDisassemblyView";

type DisassemblyViewPanelProps = {
	dumpInfo: ParsedDumpInfo;
	panelId: string;
};

export default function DisassemblyViewPanel(props: DisassemblyViewPanelProps) {
	let hostRef: HTMLDivElement | undefined;
	let disassemblyView: VanillaDisassemblyView | undefined;

	onMount(() => {
		if (!hostRef) {
			return;
		}

		disassemblyView = new VanillaDisassemblyView({
			container: hostRef,
			dumpInfo: props.dumpInfo,
			panelId: props.panelId,
		});

		onCleanup(() => {
			disassemblyView?.dispose();
			disassemblyView = undefined;
		});
	});

	createEffect(() => {
		disassemblyView?.update(props.dumpInfo);
	});

	return (
		<div
			ref={(element) => {
				hostRef = element;
			}}
			class="size-full"
		/>
	);
}
