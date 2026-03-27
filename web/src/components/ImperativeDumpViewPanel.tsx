import { type Component, createEffect, onCleanup, onMount } from "solid-js";
import type { ParsedDumpInfo } from "../lib/dumpInfo";

type DumpViewOptions = {
	container: HTMLElement;
	dumpInfo: ParsedDumpInfo;
	panelId: string;
};

type DumpViewInstance = {
	update: (nextDumpInfo: ParsedDumpInfo) => void;
	dispose: () => void;
};

type DumpViewConstructor = new (options: DumpViewOptions) => DumpViewInstance;

type DumpViewPanelProps = {
	dumpInfo: ParsedDumpInfo;
	panelId: string;
};

export const createImperativeDumpViewPanel = (
	ViewClass: DumpViewConstructor,
): Component<DumpViewPanelProps> => {
	return function ImperativeDumpViewPanel(props) {
		let hostRef: HTMLDivElement | undefined;
		let view: DumpViewInstance | undefined;

		onMount(() => {
			if (!hostRef) {
				return;
			}

			view = new ViewClass({
				container: hostRef,
				dumpInfo: props.dumpInfo,
				panelId: props.panelId,
			});

			onCleanup(() => {
				view?.dispose();
				view = undefined;
			});
		});

		createEffect(() => {
			view?.update(props.dumpInfo);
		});

		return (
			<div
				ref={(element) => {
					hostRef = element;
				}}
				class="size-full"
			/>
		);
	};
};
