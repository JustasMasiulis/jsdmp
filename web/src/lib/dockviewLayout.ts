import type {
	AddPanelPositionOptions,
	DockviewApi,
	SerializedDockview,
} from "dockview-core";

export const LAYOUT_STORAGE_KEY = "wasm-dump-debugger:dockview:v1";
type PanelSpec = {
	id: string;
	component: string;
	title: string;
};

export const PANEL_SPECS = [
	{ id: "summary", component: "summary", title: "Summary" },
	{ id: "exception", component: "exception", title: "Exception" },
	{ id: "disassembly", component: "disassembly", title: "Disassembly" },
	{
		id: "disassembly-graph",
		component: "disassembly-graph",
		title: "Graph",
	},
	{ id: "modules", component: "modules", title: "Modules" },
	{ id: "threads", component: "threads", title: "Threads" },
	{ id: "memory", component: "memory-view", title: "Memory" },
	{ id: "command", component: "command", title: "Command" },
] as const satisfies ReadonlyArray<PanelSpec>;

export type PanelId = (typeof PANEL_SPECS)[number]["id"];

const PANEL_SPECS_BY_ID = new Map(
	PANEL_SPECS.map((panel) => [panel.id, panel] as const),
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

const parsePanelNumber = (panelId: string, baseId: string): number | null => {
	if (panelId === baseId) return 1;

	const suffix = panelId.slice(baseId.length);
	const match = /^-(\d+)$/.exec(suffix);
	return match ? Number.parseInt(match[1], 10) : null;
};

const getNextPanelNumber = (dockview: DockviewApi, baseId: string): number => {
	let max = 0;

	for (const panel of dockview.panels) {
		const n = parsePanelNumber(panel.id, baseId);
		if (n !== null) max = Math.max(max, n);
	}

	return max + 1;
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

export const addPanelInstance = (
	dockview: DockviewApi,
	baseId: PanelId,
): string => {
	const spec = PANEL_SPECS_BY_ID.get(baseId);
	if (!spec) throw new Error(`Unknown panel: ${baseId}`);

	const n = getNextPanelNumber(dockview, baseId);
	const panelId = n === 1 ? baseId : `${baseId}-${n}`;
	const title = n === 1 ? spec.title : `${spec.title} #${n}`;

	dockview.addPanel({
		component: spec.component,
		id: panelId,
		position: getActivePanelPosition(dockview),
		title,
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
	addPanelIfMissing(dockview, "command", {
		direction: "below",
		referencePanel: "exception",
	});
	addPanelIfMissing(dockview, "memory", {
		direction: "within",
		referencePanel: "summary",
	});
};
