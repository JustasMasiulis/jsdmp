import {
	createDockview,
	type DockviewApi,
	type IContentRenderer,
	type IDockviewPanel,
	themeLight,
} from "dockview-core";
import {
	addMemoryPanel,
	applyDefaultLayout,
	COMMAND_COMPONENT,
	DISASSEMBLY_COMPONENT,
	DISASSEMBLY_GRAPH_COMPONENT,
	EXCEPTION_COMPONENT,
	MEMORY_COMPONENT,
	MODULES_COMPONENT,
	openPanel,
	PANEL_SPECS,
	type PanelId,
	restoreLayout,
	SUMMARY_COMPONENT,
	saveLayout,
	THREADS_COMPONENT,
} from "../lib/dockviewLayout";
import { CommandView } from "./CommandView";
import { DisassemblyGraphView } from "./DisassemblyGraphView";
import { DisassemblyView } from "./DisassemblyView";
import { ExceptionView } from "./ExceptionView";
import { MemoryView } from "./MemoryView";
import { ModulesView } from "./ModulesView";
import { SummaryView } from "./SummaryView";
import { ThreadsView } from "./ThreadsView";

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

		const onDidAddPanel = (_: IDockviewPanel) => {
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

	private createComponent = (options: {
		id: string;
		name: string;
	}): IContentRenderer => {
		const el = document.createElement("div");
		el.className = "dump-dockview-panel size-full";

		switch (options.name) {
			case DISASSEMBLY_COMPONENT:
				return new DisassemblyView(el, options.id);
			case DISASSEMBLY_GRAPH_COMPONENT:
				return new DisassemblyGraphView(el, options.id);
			case MEMORY_COMPONENT:
				return new MemoryView(el, options.id);
			case EXCEPTION_COMPONENT:
				return new ExceptionView(el);
			case MODULES_COMPONENT:
				return new ModulesView(el);
			case THREADS_COMPONENT:
				return new ThreadsView(el);
			case COMMAND_COMPONENT:
				return new CommandView(el);
			case SUMMARY_COMPONENT:
				return new SummaryView(el);
			default:
				throw new Error(`Unknown component ${options.name}`);
		}
	};

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

	dispose(): void {
		this.dockview.dispose();
		this.container.innerHTML = "";
	}
}
