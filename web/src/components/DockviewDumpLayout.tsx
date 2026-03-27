import {
	createDockview,
	type DockviewApi,
	type IContentRenderer,
	themeLight,
} from "dockview-core";
import { createSignal, For, onCleanup, onMount } from "solid-js";
import { render } from "solid-js/web";
import {
	addMemoryPanel,
	applyDefaultLayout,
	DISASSEMBLY_COMPONENT,
	DISASSEMBLY_GRAPH_COMPONENT,
	getPanelSection,
	MEMORY_COMPONENT,
	openPanel,
	PANEL_SPECS,
	type PanelId,
	restoreLayout,
	saveLayout,
} from "../lib/dockviewLayout";
import type { ParsedDumpInfo } from "../lib/dumpInfo";
import DisassemblyGraphViewPanel from "./DisassemblyGraphViewPanel";
import DisassemblyViewPanel from "./DisassemblyViewPanel";
import DumpSummary from "./DumpSummary";
import MemoryViewPanel from "./MemoryViewPanel";

type DockviewDumpLayoutProps = {
	dumpInfo: ParsedDumpInfo;
};

const createRenderedPanel = (content: () => JSX.Element): IContentRenderer => {
	const element = document.createElement("div");
	element.className = "dump-dockview-panel size-full";

	const dispose = render(content, element);

	return {
		element,
		init: () => {
			// Solid content is mounted eagerly into `element`.
		},
		dispose,
	};
};

const createDockviewRenderer =
	(dumpInfo: ParsedDumpInfo) =>
	(options: { id: string; name: string }): IContentRenderer => {
		switch (options.name) {
			case MEMORY_COMPONENT:
				return createRenderedPanel(() => (
					<MemoryViewPanel dumpInfo={dumpInfo} panelId={options.id} />
				));
			case DISASSEMBLY_COMPONENT:
				return createRenderedPanel(() => (
					<DisassemblyViewPanel dumpInfo={dumpInfo} panelId={options.id} />
				));
			case DISASSEMBLY_GRAPH_COMPONENT:
				return createRenderedPanel(() => (
					<DisassemblyGraphViewPanel dumpInfo={dumpInfo} panelId={options.id} />
				));
			default:
				return createRenderedPanel(() => (
					<DumpSummary
						dumpInfo={dumpInfo}
						sections={[getPanelSection(options.name)]}
					/>
				));
		}
	};

const subscribeToDockviewEvents = (
	dockview: DockviewApi,
	onLayoutChange: () => void,
) => [
	dockview.onDidAddPanel(onLayoutChange),
	dockview.onDidRemovePanel(onLayoutChange),
	dockview.onDidLayoutChange(onLayoutChange),
];

type ToolbarAction = "add-memory-view" | "open-panel" | "reset-layout";

type DockviewToolbarProps = {
	isOpen: (panelId: PanelId) => boolean;
	onAddMemoryView: () => void;
	onOpenPanel: (panelId: PanelId) => void;
	onResetLayout: () => void;
};

const DockviewToolbar = (props: DockviewToolbarProps) => {
	const handleClick = (
		event: MouseEvent & { currentTarget: HTMLButtonElement },
	) => {
		const action = event.currentTarget.dataset.action as
			| ToolbarAction
			| undefined;

		switch (action) {
			case "open-panel": {
				const panelId = event.currentTarget.dataset.panelId as
					| PanelId
					| undefined;
				if (panelId) {
					props.onOpenPanel(panelId);
				}
				return;
			}
			case "add-memory-view":
				props.onAddMemoryView();
				return;
			case "reset-layout":
				props.onResetLayout();
				return;
		}
	};

	return (
		<div class="dump-dockview-toolbar">
			<For each={PANEL_SPECS}>
				{(panel) => (
					<button
						type="button"
						class="dump-dockview-toolbar__button"
						data-action="open-panel"
						data-panel-id={panel.id}
						disabled={props.isOpen(panel.id)}
						onClick={handleClick}
					>
						Open {panel.title}
					</button>
				)}
			</For>
			<button
				type="button"
				class="dump-dockview-toolbar__button"
				data-action="reset-layout"
				onClick={handleClick}
			>
				Reset Layout
			</button>
			<button
				type="button"
				class="dump-dockview-toolbar__button"
				data-action="add-memory-view"
				onClick={handleClick}
			>
				Add Memory View
			</button>
		</div>
	);
};

export default function DockviewDumpLayout(props: DockviewDumpLayoutProps) {
	const [dockview, setDockview] = createSignal<DockviewApi>();
	const [layoutVersion, setLayoutVersion] = createSignal(0);
	let hostRef!: HTMLDivElement;

	const bumpLayoutVersion = () => setLayoutVersion((value) => value + 1);

	const isOpen = (panelId: PanelId) => {
		layoutVersion();
		return !!dockview()?.getPanel(panelId);
	};

	const handleOpenPanel = (panelId: PanelId) => {
		const api = dockview();
		if (!api) {
			return;
		}

		if (openPanel(api, panelId)) {
			saveLayout(api);
			bumpLayoutVersion();
		}
	};

	const handleAddMemoryView = () => {
		const api = dockview();
		if (!api) {
			return;
		}

		addMemoryPanel(api);
		saveLayout(api);
		bumpLayoutVersion();
	};

	const handleResetLayout = () => {
		const api = dockview();
		if (!api) {
			return;
		}

		applyDefaultLayout(api);
		saveLayout(api);
		bumpLayoutVersion();
	};

	onMount(() => {
		const api = createDockview(hostRef, {
			createComponent: createDockviewRenderer(props.dumpInfo),
			theme: themeLight,
		});

		setDockview(api);

		const subscriptions = subscribeToDockviewEvents(api, () => {
			saveLayout(api);
			bumpLayoutVersion();
		});

		if (!restoreLayout(api)) {
			applyDefaultLayout(api);
			saveLayout(api);
		}
		bumpLayoutVersion();

		onCleanup(() => {
			for (const subscription of subscriptions) {
				subscription.dispose();
			}
			api.dispose();
			setDockview(undefined);
		});
	});

	return (
		<section class="dump-dockview-shell" aria-label="Docked dump details">
			<DockviewToolbar
				isOpen={isOpen}
				onAddMemoryView={handleAddMemoryView}
				onOpenPanel={handleOpenPanel}
				onResetLayout={handleResetLayout}
			/>
			<div ref={hostRef} class="dump-dockview-host" />
		</section>
	);
}
