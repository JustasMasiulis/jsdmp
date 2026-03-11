import { createEffect, onCleanup, onMount } from "solid-js";
import type { ParsedDumpInfo } from "./DumpSummary";
import { VanillaMemoryView } from "./VanillaMemoryView";

type MemoryViewPanelProps = {
	dumpInfo: ParsedDumpInfo;
	panelId: string;
};

export default function MemoryViewPanel(props: MemoryViewPanelProps) {
	let hostRef: HTMLDivElement | undefined;
	let memoryView: VanillaMemoryView | undefined;

	onMount(() => {
		if (!hostRef) {
			return;
		}

		memoryView = new VanillaMemoryView({
			container: hostRef,
			dumpInfo: props.dumpInfo,
			panelId: props.panelId,
		});

		onCleanup(() => {
			memoryView?.dispose();
			memoryView = undefined;
		});
	});

	createEffect(() => {
		memoryView?.update(props.dumpInfo);
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
