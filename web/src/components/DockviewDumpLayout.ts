import {
	createDockview,
	type DockviewApi,
	type IContentRenderer,
	themeLight,
} from "dockview-core";
import { resolveContextForThread } from "../lib/context";
import type { ParsedDumpInfo } from "../lib/dumpInfo";
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
import { VanillaDumpSummary } from "./VanillaDumpSummary";
import { VanillaDisassemblyView } from "./VanillaDisassemblyView";
import { VanillaDisassemblyGraphView } from "./VanillaDisassemblyGraphView";
import { VanillaMemoryView } from "./VanillaMemoryView";

export class DockviewDumpLayout {
	private dockview: DockviewApi;
	private selectedThreadId: number;
	private summaryPanels = new Set<VanillaDumpSummary>();
	private disassemblyPanels = new Set<VanillaDisassemblyView>();
	private graphPanels = new Set<VanillaDisassemblyGraphView>();
	private toolbar: HTMLElement;

	constructor(
		private container: HTMLElement,
		private dumpInfo: ParsedDumpInfo,
	) {
		this.selectedThreadId = dumpInfo.debugInterface.dm.currentThreadId;

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

		const onLayoutChange = () => {
			saveLayout(this.dockview);
			this.refreshToolbar();
		};
		this.dockview.onDidAddPanel(onLayoutChange);
		this.dockview.onDidRemovePanel(onLayoutChange);
		this.dockview.onDidLayoutChange(onLayoutChange);

		if (!restoreLayout(this.dockview)) {
			applyDefaultLayout(this.dockview);
			saveLayout(this.dockview);
		}
		this.refreshToolbar();
	}

	// ─── thread switching ─────────────────────────────────────────────────────

	private onThreadSelect = async (threadId: number): Promise<void> => {
		this.selectedThreadId = threadId;
		for (const p of this.summaryPanels) p.setSelectedThreadId(threadId);

		const newContext = await resolveContextForThread(
			this.dumpInfo.debugInterface,
			threadId,
		);
		const newDumpInfo: ParsedDumpInfo = {
			...this.dumpInfo,
			resolvedContext: newContext ?? this.dumpInfo.resolvedContext,
		};
		for (const v of this.disassemblyPanels) v.update(newDumpInfo);
		for (const v of this.graphPanels) v.update(newDumpInfo);
	};

	// ─── panel factory ────────────────────────────────────────────────────────

	private createComponent = (options: { id: string; name: string }): IContentRenderer => {
		const el = document.createElement("div");
		el.className = "dump-dockview-panel size-full";

		switch (options.name) {
			case DISASSEMBLY_COMPONENT: {
				const view = new VanillaDisassemblyView({
					container: el,
					dumpInfo: this.dumpInfo,
					panelId: options.id,
				});
				this.disassemblyPanels.add(view);
				return {
					element: el,
					init: () => {},
					dispose: () => {
						view.dispose();
						this.disassemblyPanels.delete(view);
					},
				};
			}
			case DISASSEMBLY_GRAPH_COMPONENT: {
				const view = new VanillaDisassemblyGraphView({
					container: el,
					dumpInfo: this.dumpInfo,
					panelId: options.id,
				});
				this.graphPanels.add(view);
				return {
					element: el,
					init: () => {},
					dispose: () => {
						view.dispose();
						this.graphPanels.delete(view);
					},
				};
			}
			case MEMORY_COMPONENT: {
				const view = new VanillaMemoryView({
					container: el,
					dumpInfo: this.dumpInfo,
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
					dumpInfo: this.dumpInfo,
					sections: [getPanelSection(options.name)],
					selectedThreadId: this.selectedThreadId,
					onThreadSelect: this.onThreadSelect,
				});
				this.summaryPanels.add(summary);
				return {
					element: el,
					init: () => {},
					dispose: () => {
						summary.dispose();
						this.summaryPanels.delete(summary);
					},
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
		const btn = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-action]");
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
