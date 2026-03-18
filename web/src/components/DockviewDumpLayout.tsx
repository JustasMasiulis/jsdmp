import {
	type AddPanelPositionOptions,
	createDockview,
	type DockviewApi,
	type IContentRenderer,
	type SerializedDockview,
	themeLight,
} from "dockview-core";
import { createSignal, For, onCleanup, onMount } from "solid-js";
import { render } from "solid-js/web";
import DisassemblyGraphViewPanel from "./DisassemblyGraphViewPanel";
import DisassemblyViewPanel from "./DisassemblyViewPanel";
import DumpSummary, {
	type DumpSection,
	type ParsedDumpInfo,
} from "./DumpSummary";
import MemoryViewPanel from "./MemoryViewPanel";

const LAYOUT_STORAGE_KEY = "wasm-dump-debugger:dockview:v1";
const MEMORY_COMPONENT = "memory-view";
const DISASSEMBLY_COMPONENT = "disassembly";
const DISASSEMBLY_GRAPH_COMPONENT = "disassembly-graph";
const MEMORY_BASE_ID = "memory";

const PANEL_SPECS = [
	{
		id: "summary",
		component: "summary",
		section: "summary",
		title: "Summary",
	},
	{
		id: "exception",
		component: "exception",
		section: "exception",
		title: "Exception",
	},
	{
		id: "disassembly",
		component: "disassembly",
		section: "disassembly",
		title: "Disassembly",
	},
	{
		id: "disassembly-graph",
		component: DISASSEMBLY_GRAPH_COMPONENT,
		section: "disassembly",
		title: "Disassembly Graph",
	},
	{
		id: "modules",
		component: "modules",
		section: "modules",
		title: "Modules",
	},
	{
		id: "threads",
		component: "threads",
		section: "threads",
		title: "Threads",
	},
	{
		id: MEMORY_BASE_ID,
		component: MEMORY_COMPONENT,
		section: "memory",
		title: "Memory",
	},
] as const satisfies ReadonlyArray<{
	id: string;
	component: string;
	section: DumpSection;
	title: string;
}>;

type PanelId = (typeof PANEL_SPECS)[number]["id"];

type DockviewDumpLayoutProps = {
	dumpInfo: ParsedDumpInfo;
};

const createSummaryRenderer = (
	dumpInfo: ParsedDumpInfo,
	section: DumpSection,
): IContentRenderer => {
	const element = document.createElement("div");
	element.className = "dump-dockview-panel size-full";

	const dispose = render(
		() => <DumpSummary dumpInfo={dumpInfo} sections={[section]} />,
		element,
	);

	return {
		element,
		init: () => {
			// Solid content is mounted eagerly into `element`.
		},
		dispose,
	};
};

const createMemoryRenderer = (
	dumpInfo: ParsedDumpInfo,
	panelId: string,
): IContentRenderer => {
	const element = document.createElement("div");
	element.className = "dump-dockview-panel size-full";

	const dispose = render(
		() => <MemoryViewPanel dumpInfo={dumpInfo} panelId={panelId} />,
		element,
	);

	return {
		element,
		init: () => {
			// Solid content is mounted eagerly into `element`.
		},
		dispose,
	};
};

const createDisassemblyRenderer = (
	dumpInfo: ParsedDumpInfo,
	panelId: string,
): IContentRenderer => {
	const element = document.createElement("div");
	element.className = "dump-dockview-panel size-full";

	const dispose = render(
		() => <DisassemblyViewPanel dumpInfo={dumpInfo} panelId={panelId} />,
		element,
	);

	return {
		element,
		init: () => {
			// Solid content is mounted eagerly into `element`.
		},
		dispose,
	};
};

const createDisassemblyGraphRenderer = (
	dumpInfo: ParsedDumpInfo,
	panelId: string,
): IContentRenderer => {
	const element = document.createElement("div");
	element.className = "dump-dockview-panel size-full";

	const dispose = render(
		() => <DisassemblyGraphViewPanel dumpInfo={dumpInfo} panelId={panelId} />,
		element,
	);

	return {
		element,
		init: () => {
			// Solid content is mounted eagerly into `element`.
		},
		dispose,
	};
};

const parseMemoryPanelNumber = (panelId: string): number | null => {
	if (panelId === MEMORY_BASE_ID) {
		return 1;
	}

	const match = /^memory-(\d+)$/.exec(panelId);
	if (!match) {
		return null;
	}
	return Number.parseInt(match[1], 10);
};

const getNextMemoryPanelNumber = (dockview: DockviewApi): number => {
	let maxPanelNumber = 1;
	for (const panel of dockview.panels) {
		const panelNumber = parseMemoryPanelNumber(panel.id);
		if (panelNumber) {
			maxPanelNumber = Math.max(maxPanelNumber, panelNumber);
		}
	}
	return maxPanelNumber + 1;
};

const saveLayout = (dockview: DockviewApi) => {
	try {
		window.localStorage.setItem(
			LAYOUT_STORAGE_KEY,
			JSON.stringify(dockview.toJSON()),
		);
	} catch {
		// Ignore storage failures so layout interactions continue to work.
	}
};

const restoreLayout = (dockview: DockviewApi): boolean => {
	const serialized = window.localStorage.getItem(LAYOUT_STORAGE_KEY);
	if (!serialized) {
		return false;
	}

	try {
		const layout = JSON.parse(serialized) as SerializedDockview;
		dockview.fromJSON(layout);
		return true;
	} catch {
		window.localStorage.removeItem(LAYOUT_STORAGE_KEY);
		return false;
	}
};

const getPanelSpec = (panelId: PanelId) =>
	PANEL_SPECS.find((spec) => spec.id === panelId);

const addPanelIfMissing = (
	dockview: DockviewApi,
	panelId: PanelId,
	position?: AddPanelPositionOptions,
) => {
	if (dockview.getPanel(panelId)) {
		return;
	}

	const panelSpec = getPanelSpec(panelId);
	if (!panelSpec) {
		return;
	}

	dockview.addPanel({
		component: panelSpec.component,
		id: panelSpec.id,
		position,
		title: panelSpec.title,
	});
};

const applyDefaultLayout = (dockview: DockviewApi) => {
	dockview.clear();
	addPanelIfMissing(dockview, "summary");
	addPanelIfMissing(dockview, "disassembly", {
		direction: "right",
		referencePanel: "summary",
	});
	addPanelIfMissing(dockview, "disassembly-graph", {
		direction: "right",
		referencePanel: "disassembly",
	});
	addPanelIfMissing(dockview, "exception", {
		direction: "below",
		referencePanel: "summary",
	});
	addPanelIfMissing(dockview, "modules", {
		direction: "below",
		referencePanel: "disassembly-graph",
	});
	addPanelIfMissing(dockview, "threads", {
		direction: "right",
		referencePanel: "modules",
	});
	addPanelIfMissing(dockview, "memory", {
		direction: "within",
		referencePanel: "summary",
	});
};

export default function DockviewDumpLayout(props: DockviewDumpLayoutProps) {
	const [dockview, setDockview] = createSignal<DockviewApi>();
	const [layoutVersion, setLayoutVersion] = createSignal(0);
	let hostRef: HTMLDivElement | undefined;

	const bumpLayoutVersion = () => {
		setLayoutVersion((value) => value + 1);
	};

	const isOpen = (panelId: PanelId) => {
		layoutVersion();
		return !!dockview()?.getPanel(panelId);
	};

	const openPanel = (panelId: PanelId) => {
		const api = dockview();
		if (!api) {
			return;
		}

		const existing = api.getPanel(panelId);
		if (existing) {
			existing.api.setActive();
			return;
		}

		const activePanelId = api.activePanel?.id;
		addPanelIfMissing(
			api,
			panelId,
			activePanelId
				? {
						direction: "within",
						referencePanel: activePanelId,
				  }
				: undefined,
		);
		saveLayout(api);
		bumpLayoutVersion();
	};

	const addMemoryView = () => {
		const api = dockview();
		if (!api) {
			return;
		}

		const panelNumber = getNextMemoryPanelNumber(api);
		const panelId = `memory-${panelNumber}`;
		const activePanelId = api.activePanel?.id;
		api.addPanel({
			component: MEMORY_COMPONENT,
			id: panelId,
			title: `Memory #${panelNumber}`,
			position: activePanelId
				? {
						direction: "within",
						referencePanel: activePanelId,
				  }
				: undefined,
		});
		saveLayout(api);
		bumpLayoutVersion();
	};

	const resetLayout = () => {
		const api = dockview();
		if (!api) {
			return;
		}

		applyDefaultLayout(api);
		saveLayout(api);
		bumpLayoutVersion();
	};

	onMount(() => {
		if (!hostRef) {
			return;
		}

		const panelSections = new Map(
			PANEL_SPECS.map((panel) => [panel.component, panel.section] as const),
		);

		const api = createDockview(hostRef, {
			createComponent: (options) => {
				if (options.name === MEMORY_COMPONENT) {
					return createMemoryRenderer(props.dumpInfo, options.id);
				}
				if (options.name === DISASSEMBLY_COMPONENT) {
					return createDisassemblyRenderer(props.dumpInfo, options.id);
				}
				if (options.name === DISASSEMBLY_GRAPH_COMPONENT) {
					return createDisassemblyGraphRenderer(props.dumpInfo, options.id);
				}

				return createSummaryRenderer(
					props.dumpInfo,
					panelSections.get(options.name) ?? "summary",
				);
			},
			theme: themeLight,
		});

		setDockview(api);

		const subscriptions = [
			api.onDidAddPanel(() => {
				bumpLayoutVersion();
			}),
			api.onDidRemovePanel(() => {
				bumpLayoutVersion();
			}),
			api.onDidLayoutChange(() => {
				saveLayout(api);
				bumpLayoutVersion();
			}),
		];

		const restored = restoreLayout(api);
		if (!restored) {
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
			<div class="dump-dockview-toolbar">
				<For each={PANEL_SPECS}>
					{(panel) => (
						<button
							type="button"
							class="dump-dockview-toolbar__button"
							disabled={isOpen(panel.id)}
							onClick={() => {
								openPanel(panel.id);
							}}
						>
							Open {panel.title}
						</button>
					)}
				</For>
				<button
					type="button"
					class="dump-dockview-toolbar__button"
					onClick={resetLayout}
				>
					Reset Layout
				</button>
				<button
					type="button"
					class="dump-dockview-toolbar__button"
					onClick={addMemoryView}
				>
					Add Memory View
				</button>
			</div>

			<div
				ref={(element) => {
					hostRef = element;
				}}
				class="dump-dockview-host"
			/>
		</section>
	);
}