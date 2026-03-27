import type {
	AddPanelPositionOptions,
	DockviewApi,
	SerializedDockview,
} from "dockview-core";
import type { DumpSection } from "./dumpSections";

export const LAYOUT_STORAGE_KEY = "wasm-dump-debugger:dockview:v1";
export const MEMORY_COMPONENT = "memory-view";
export const DISASSEMBLY_COMPONENT = "disassembly";
export const DISASSEMBLY_GRAPH_COMPONENT = "disassembly-graph";
export const MEMORY_BASE_ID = "memory";

type PanelSpec = {
	id: string;
	component: string;
	section: DumpSection;
	title: string;
};

export const PANEL_SPECS = [
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
] as const satisfies ReadonlyArray<PanelSpec>;

export type PanelId = (typeof PANEL_SPECS)[number]["id"];

const PANEL_SPECS_BY_ID = new Map(
	PANEL_SPECS.map((panel) => [panel.id, panel] as const),
);

const PANEL_SECTIONS_BY_COMPONENT = new Map(
	PANEL_SPECS.map((panel) => [panel.component, panel.section] as const),
);

type LayoutStorage = Pick<Storage, "getItem" | "removeItem" | "setItem">;

const getLayoutStorage = (
	storage?: LayoutStorage | null,
): LayoutStorage | null => {
	if (storage !== undefined) {
		return storage;
	}
	return typeof window === "undefined" ? null : window.localStorage;
};

const getActivePanelPosition = (
	dockview: DockviewApi,
): AddPanelPositionOptions | undefined => {
	const activePanelId = dockview.activePanel?.id;
	return activePanelId
		? {
				direction: "within",
				referencePanel: activePanelId,
			}
		: undefined;
};

export const getPanelSection = (component: string): DumpSection =>
	PANEL_SECTIONS_BY_COMPONENT.get(component) ?? "summary";

export const parseMemoryPanelNumber = (panelId: string): number | null => {
	if (panelId === MEMORY_BASE_ID) {
		return 1;
	}

	const match = /^memory-(\d+)$/.exec(panelId);
	if (!match) {
		return null;
	}

	return Number.parseInt(match[1], 10);
};

export const getNextMemoryPanelNumber = (dockview: DockviewApi): number => {
	let maxPanelNumber = 1;

	for (const panel of dockview.panels) {
		const panelNumber = parseMemoryPanelNumber(panel.id);
		if (panelNumber) {
			maxPanelNumber = Math.max(maxPanelNumber, panelNumber);
		}
	}

	return maxPanelNumber + 1;
};

export const saveLayout = (
	dockview: DockviewApi,
	storage?: LayoutStorage | null,
) => {
	const targetStorage = getLayoutStorage(storage);
	if (!targetStorage) {
		return;
	}

	try {
		targetStorage.setItem(
			LAYOUT_STORAGE_KEY,
			JSON.stringify(dockview.toJSON()),
		);
	} catch {
		// Ignore storage failures so layout interactions continue to work.
	}
};

export const restoreLayout = (
	dockview: DockviewApi,
	storage?: LayoutStorage | null,
): boolean => {
	const targetStorage = getLayoutStorage(storage);
	if (!targetStorage) {
		return false;
	}

	const serializedLayout = targetStorage.getItem(LAYOUT_STORAGE_KEY);
	if (!serializedLayout) {
		return false;
	}

	try {
		dockview.fromJSON(JSON.parse(serializedLayout) as SerializedDockview);
		return true;
	} catch {
		targetStorage.removeItem(LAYOUT_STORAGE_KEY);
		return false;
	}
};

export const addPanelIfMissing = (
	dockview: DockviewApi,
	panelId: PanelId,
	position?: AddPanelPositionOptions,
) => {
	if (dockview.getPanel(panelId)) {
		return false;
	}

	const panelSpec = PANEL_SPECS_BY_ID.get(panelId);
	if (!panelSpec) {
		return false;
	}

	dockview.addPanel({
		component: panelSpec.component,
		id: panelSpec.id,
		position,
		title: panelSpec.title,
	});

	return true;
};

export const openPanel = (dockview: DockviewApi, panelId: PanelId): boolean => {
	const existingPanel = dockview.getPanel(panelId);
	if (existingPanel) {
		existingPanel.api.setActive();
		return false;
	}

	return addPanelIfMissing(dockview, panelId, getActivePanelPosition(dockview));
};

export const addMemoryPanel = (dockview: DockviewApi): string => {
	const panelNumber = getNextMemoryPanelNumber(dockview);
	const panelId = `memory-${panelNumber}`;

	dockview.addPanel({
		component: MEMORY_COMPONENT,
		id: panelId,
		position: getActivePanelPosition(dockview),
		title: `Memory #${panelNumber}`,
	});

	return panelId;
};

export const applyDefaultLayout = (dockview: DockviewApi) => {
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
	addPanelIfMissing(dockview, MEMORY_BASE_ID, {
		direction: "within",
		referencePanel: "summary",
	});
};
