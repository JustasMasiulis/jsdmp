import {
	createDockview,
	type DockviewApi,
	type IContentRenderer,
	themeLight,
} from "dockview-core";
import {
	addMemoryPanel,
	applyDefaultLayout,
	openPanel,
	PANEL_SPECS,
	type PanelId,
	restoreLayout,
	saveLayout,
} from "../lib/dockviewLayout";
import { CommandView } from "./CommandView";
import { DisassemblyGraphView } from "./DisassemblyGraphView";
import { DisassemblyView } from "./DisassemblyView";
import { ExceptionView } from "./ExceptionView";
import { MemoryView } from "./MemoryView";
import { ModulesView } from "./ModulesView";
import { SummaryView } from "./SummaryView";
import { ThreadsView } from "./ThreadsView";

type ComponentFactory = (el: HTMLElement, panelId: string) => IContentRenderer;

const COMPONENT_FACTORIES = new Map<string, ComponentFactory>([
	["disassembly", (el, id) => new DisassemblyView(el, id)],
	["disassembly-graph", (el, id) => new DisassemblyGraphView(el, id)],
	["memory-view", (el, id) => new MemoryView(el, id)],
	["exception", (el) => new ExceptionView(el)],
	["modules", (el) => new ModulesView(el)],
	["threads", (el) => new ThreadsView(el)],
	["command", (el) => new CommandView(el)],
	["summary", (el) => new SummaryView(el)],
]);

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

		const onLayoutChange = () => this.saveAndRefresh();
		this.dockview.onDidAddPanel(onLayoutChange);
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

		const factory = COMPONENT_FACTORIES.get(options.name);
		if (!factory) {
			throw new Error(`Unknown component: ${options.name}`);
		}
		return factory(el, options.id);
	};

	private saveAndRefresh(): void {
		saveLayout(this.dockview);
		this.refreshToolbar();
	}

	private buildToolbar(): HTMLElement {
		const toolbar = document.createElement("div");
		toolbar.className = "dump-dockview-toolbar";
		toolbar.addEventListener("click", this.onToolbarClick);
		this.refreshToolbar(toolbar);
		return toolbar;
	}

	private refreshToolbar(toolbar?: HTMLElement): void {
		const target = toolbar ?? this.toolbar;
		target.innerHTML = "";

		for (const panel of PANEL_SPECS) {
			const btn = document.createElement("button");
			btn.type = "button";
			btn.className = "dump-dockview-toolbar__button";
			btn.dataset.action = "open-panel";
			btn.dataset.panelId = panel.id;
			btn.textContent = `Open ${panel.title}`;
			btn.disabled = !!this.dockview?.getPanel(panel.id);
			target.append(btn);
		}

		const resetBtn = document.createElement("button");
		resetBtn.type = "button";
		resetBtn.className = "dump-dockview-toolbar__button";
		resetBtn.dataset.action = "reset-layout";
		resetBtn.textContent = "Reset Layout";
		target.append(resetBtn);

		const memBtn = document.createElement("button");
		memBtn.type = "button";
		memBtn.className = "dump-dockview-toolbar__button";
		memBtn.dataset.action = "add-memory-view";
		memBtn.textContent = "Add Memory View";
		target.append(memBtn);
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
					this.saveAndRefresh();
				}
				break;
			}
			case "reset-layout":
				applyDefaultLayout(this.dockview);
				this.saveAndRefresh();
				break;
			case "add-memory-view":
				addMemoryPanel(this.dockview);
				this.saveAndRefresh();
				break;
		}
	};

	dispose(): void {
		this.dockview.dispose();
		this.container.innerHTML = "";
	}
}
