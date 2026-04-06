import {
	createDockview,
	type DockviewApi,
	type IContentRenderer,
	themeLight,
} from "dockview-core";
import {
	addPanelInstance,
	applyDefaultLayout,
	PANEL_SPECS,
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

export type LayoutCallbacks = {
	onOpenFile?: () => void;
};

export class DockviewDumpLayout {
	private dockview: DockviewApi;
	private menubar: HTMLElement;
	private openMenu: HTMLElement | null = null;

	constructor(
		private container: HTMLElement,
		private callbacks: LayoutCallbacks = {},
	) {
		this.menubar = this.buildMenubar();
		container.append(this.menubar);

		const shell = document.createElement("section");
		shell.className = "dump-dockview-shell";
		shell.setAttribute("aria-label", "Docked dump details");
		container.append(shell);

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
		document.addEventListener("pointerdown", this.onDocumentPointerDown);
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
	}

	private buildMenubar(): HTMLElement {
		const bar = document.createElement("div");
		bar.className = "menubar";
		bar.setAttribute("role", "menubar");

		bar.append(
			this.buildDropdown("File", this.buildFileMenu),
			this.buildDropdown("View", this.buildViewMenu),
			this.buildResetButton(),
		);

		return bar;
	}

	private buildDropdown(
		label: string,
		buildItems: () => HTMLElement,
	): HTMLElement {
		const wrapper = document.createElement("div");
		wrapper.className = "menubar__dropdown";

		const trigger = document.createElement("button");
		trigger.type = "button";
		trigger.className = "menubar__trigger";
		trigger.textContent = label;
		trigger.setAttribute("aria-haspopup", "true");
		trigger.setAttribute("aria-expanded", "false");
		wrapper.append(trigger);

		const menu = buildItems();
		menu.className = "menubar__menu";
		menu.setAttribute("role", "menu");
		menu.hidden = true;
		wrapper.append(menu);

		trigger.addEventListener("pointerdown", (e) => {
			e.preventDefault();
			if (this.openMenu === menu) {
				this.closeMenus();
			} else {
				this.closeMenus();
				this.showMenu(trigger, menu);
			}
		});

		trigger.addEventListener("pointerenter", () => {
			if (this.openMenu && this.openMenu !== menu) {
				this.closeMenus();
				this.showMenu(trigger, menu);
			}
		});

		return wrapper;
	}

	private showMenu(trigger: HTMLButtonElement, menu: HTMLElement): void {
		trigger.setAttribute("aria-expanded", "true");
		trigger.classList.add("menubar__trigger--active");
		menu.hidden = false;
		this.openMenu = menu;
	}

	private closeMenus(): void {
		if (!this.openMenu) return;
		this.openMenu.hidden = true;
		this.openMenu = null;
		for (const trigger of this.menubar.querySelectorAll(".menubar__trigger")) {
			trigger.setAttribute("aria-expanded", "false");
			trigger.classList.remove("menubar__trigger--active");
		}
	}

	private onDocumentPointerDown = (e: PointerEvent): void => {
		if (!this.openMenu) return;
		if (!(e.target instanceof Node) || !this.menubar.contains(e.target)) {
			this.closeMenus();
		}
	};

	private buildFileMenu = (): HTMLElement => {
		const menu = document.createElement("div");

		const openItem = this.menuItem("Open File\u2026", () => {
			this.callbacks.onOpenFile?.();
		});
		openItem.dataset.menuId = "open-file";
		menu.append(openItem);

		return menu;
	};

	private buildViewMenu = (): HTMLElement => {
		const menu = document.createElement("div");

		for (const panel of PANEL_SPECS) {
			menu.append(
				this.menuItem(panel.title, () => {
					addPanelInstance(this.dockview, panel.id);
					this.saveAndRefresh();
				}),
			);
		}

		return menu;
	};

	private buildResetButton(): HTMLElement {
		const btn = document.createElement("button");
		btn.type = "button";
		btn.className = "menubar__trigger";
		btn.textContent = "Reset Layout";
		btn.addEventListener("click", () => {
			applyDefaultLayout(this.dockview);
			this.saveAndRefresh();
		});
		return btn;
	}

	private menuItem(label: string, action: () => void): HTMLButtonElement {
		const btn = document.createElement("button");
		btn.type = "button";
		btn.className = "menubar__item";
		btn.setAttribute("role", "menuitem");
		btn.textContent = label;
		btn.addEventListener("click", () => {
			action();
			this.closeMenus();
		});
		return btn;
	}

	dispose(): void {
		document.removeEventListener("pointerdown", this.onDocumentPointerDown);
		this.dockview.dispose();
		this.container.innerHTML = "";
	}
}
