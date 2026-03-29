import {
	createDockview,
	type DockviewApi,
	type IContentRenderer,
	type IDockviewPanel,
	themeLight,
	type VisibilityEvent,
} from "dockview-core";
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
	THREADS_COMPONENT,
} from "../lib/dockviewLayout";
import { VanillaDisassemblyGraphView } from "./VanillaDisassemblyGraphView";
import { VanillaDisassemblyView } from "./VanillaDisassemblyView";
import { VanillaDumpSummary } from "./VanillaDumpSummary";
import { VanillaMemoryView } from "./VanillaMemoryView";
import { VanillaThreadsView } from "./VanillaThreadsView";

export class DockviewDumpLayout {
	private dockview: DockviewApi;
	private toolbar: HTMLElement;

	constructor(private container: HTMLElement) {
		const shell = document.createElement("section");
		shell.className = "dump-dockview-shell";
		shell.setAttribute("aria-label", "Docked dump details");
		container.append(shell);

		this.toolbar = this.buildToolbar();
		shell.append(this.toolbar);

		const host = document.createElement("div");
		host.className = "dump-dockview-host";
		shell.append(host);

		this.dockview = createDockview(host, {
			createComponent: this.createComponent,
			theme: themeLight,
		});

		const onDidAddPanel = (panel: IDockviewPanel) => {
			panel.api.onDidVisibilityChange((e: VisibilityEvent) => {
				console.log("visibility changed", e.isVisible);
			});

			onLayoutChange();
		};

		const onLayoutChange = () => {
			saveLayout(this.dockview);
			this.refreshToolbar();
		};
		this.dockview.onDidAddPanel(onDidAddPanel);
		this.dockview.onDidRemovePanel(onLayoutChange);
		this.dockview.onDidLayoutChange(onLayoutChange);

		if (!restoreLayout(this.dockview)) {
			applyDefaultLayout(this.dockview);
			saveLayout(this.dockview);
		}
		this.refreshToolbar();
	}

	// ─── panel factory ────────────────────────────────────────────────────────

	private createComponent = (options: {
		id: string;
		name: string;
	}): IContentRenderer => {
		const el = document.createElement("div");
		el.className = "dump-dockview-panel size-full";

		switch (options.name) {
			case DISASSEMBLY_COMPONENT: {
				const view = new VanillaDisassemblyView({
					container: el,
					panelId: options.id,
				});
				return {
					element: el,
					init: () => {},
					dispose: () => view.dispose(),
				};
			}
			case DISASSEMBLY_GRAPH_COMPONENT: {
				const view = new VanillaDisassemblyGraphView({
					container: el,
					panelId: options.id,
				});
				return {
					element: el,
					init: () => {},
					dispose: () => view.dispose(),
				};
			}
			case MEMORY_COMPONENT: {
				const view = new VanillaMemoryView({
					container: el,
					panelId: options.id,
				});
				return {
					element: el,
					init: () => {},
					dispose: () => view.dispose(),
				};
			}
			case THREADS_COMPONENT: {
				const view = new VanillaThreadsView({
					container: el,
					panelId: options.id,
				});
				return {
					element: el,
					init: () => {},
					dispose: () => view.dispose(),
				};
			}
			default: {
				const summary = new VanillaDumpSummary({
					container: el,
					sections: [getPanelSection(options.name)],
				});
				return {
					element: el,
					init: () => {},
					dispose: () => summary.dispose(),
				};
			}
		}
	};

	// ─── toolbar ──────────────────────────────────────────────────────────────

	private buildToolbar(): HTMLElement {
		const toolbar = document.createElement("div");
		toolbar.className = "dump-dockview-toolbar";
		toolbar.addEventListener("click", this.onToolbarClick);
		this.populateToolbar(toolbar);
		return toolbar;
	}

	private populateToolbar(toolbar: HTMLElement): void {
		toolbar.innerHTML = "";

		for (const panel of PANEL_SPECS) {
			const btn = document.createElement("button");
			btn.type = "button";
			btn.className = "dump-dockview-toolbar__button";
			btn.dataset.action = "open-panel";
			btn.dataset.panelId = panel.id;
			btn.textContent = `Open ${panel.title}`;
			btn.disabled = !!this.dockview?.getPanel(panel.id);
			toolbar.append(btn);
		}

		const resetBtn = document.createElement("button");
		resetBtn.type = "button";
		resetBtn.className = "dump-dockview-toolbar__button";
		resetBtn.dataset.action = "reset-layout";
		resetBtn.textContent = "Reset Layout";
		toolbar.append(resetBtn);

		const memBtn = document.createElement("button");
		memBtn.type = "button";
		memBtn.className = "dump-dockview-toolbar__button";
		memBtn.dataset.action = "add-memory-view";
		memBtn.textContent = "Add Memory View";
		toolbar.append(memBtn);
	}

	private refreshToolbar(): void {
		this.populateToolbar(this.toolbar);
	}

	private onToolbarClick = (event: MouseEvent): void => {
		const btn = (event.target as HTMLElement).closest<HTMLButtonElement>(
			"button[data-action]",
		);
		if (!btn) return;

		switch (btn.dataset.action) {
			case "open-panel": {
				const panelId = btn.dataset.panelId as PanelId | undefined;
				if (panelId && openPanel(this.dockview, panelId)) {
					saveLayout(this.dockview);
					this.refreshToolbar();
				}
				break;
			}
			case "reset-layout":
				applyDefaultLayout(this.dockview);
				saveLayout(this.dockview);
				this.refreshToolbar();
				break;
			case "add-memory-view":
				addMemoryPanel(this.dockview);
				saveLayout(this.dockview);
				this.refreshToolbar();
				break;
		}
	};

	// ─── lifecycle ────────────────────────────────────────────────────────────

	dispose(): void {
		this.dockview.dispose();
		this.container.innerHTML = "";
	}
}
