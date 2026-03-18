import { createEffect, onCleanup, onMount } from "solid-js";
import type { ParsedDumpInfo } from "./DumpSummary";
import { VanillaDisassemblyGraphView } from "./VanillaDisassemblyGraphView";

type DisassemblyGraphViewPanelProps = {
	dumpInfo: ParsedDumpInfo;
	panelId: string;
};

export default function DisassemblyGraphViewPanel(
	props: DisassemblyGraphViewPanelProps,
) {
	let hostRef: HTMLDivElement | undefined;
	let graphView: VanillaDisassemblyGraphView | undefined;

	onMount(() => {
		if (!hostRef) {
			return;
		}

		graphView = new VanillaDisassemblyGraphView({
			container: hostRef,
			dumpInfo: props.dumpInfo,
			panelId: props.panelId,
		});

		onCleanup(() => {
			graphView?.dispose();
			graphView = undefined;
		});
	});

	createEffect(() => {
		graphView?.update(props.dumpInfo);
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