import type {
	GroupPanelPartInitParameters,
	IContentRenderer,
} from "dockview-core";
import { html, render } from "lit-html";
import type { DebugModule, DebugUnloadedModule } from "../lib/debug_interface";
import { DBG } from "../lib/debugState";
import { fmtHex8, fmtHex16 } from "../lib/formatting";
import { Signal, type SignalHandle } from "../lib/reactive";
import { EMPTY_CELL } from "../lib/templates";

const MODULE_HEADERS = [
	"Base",
	"Size",
	"Checksum",
	"TimeDateStamp",
	"Name",
	"PDB",
	"GUID",
	"Age",
];

const UNLOADED_HEADERS = ["Base", "Size", "Checksum", "TimeDateStamp", "Name"];

const moduleToRow = (m: DebugModule): string[] => [
	fmtHex16(m.address),
	fmtHex8(m.size),
	fmtHex8(m.checksum),
	fmtHex8(m.timeDateStamp),
	m.path || EMPTY_CELL,
	m.pdb?.path || EMPTY_CELL,
	m.pdb?.guid || EMPTY_CELL,
	m.pdb ? String(m.pdb.age) : EMPTY_CELL,
];

const unloadedModuleToRow = (m: DebugUnloadedModule): string[] => [
	fmtHex16(m.address),
	fmtHex8(m.size),
	fmtHex8(m.checksum),
	fmtHex8(m.timeDateStamp),
	m.path || EMPTY_CELL,
];

const tableTemplate = (
	headers: string[],
	rows: string[][],
	title?: string,
) => html`
	<div class="dump-info-panel__table-wrap">
		${title ? html`<p class="dump-info-panel__table-title text-medium">${title}</p>` : ""}
		<table class="dump-info-table">
			<thead>
				<tr>
					${headers.map((h) => html`<th>${h}</th>`)}
				</tr>
			</thead>
			<tbody>
				${
					rows.length === 0
						? html`<tr>
							<td colspan=${headers.length}>
								<code>none</code>
							</td>
						</tr>`
						: rows.map(
								(row) => html`
								<tr>
									${row.map((cell) => html`<td><code>${cell}</code></td>`)}
								</tr>
							`,
							)
				}
			</tbody>
		</table>
	</div>
`;

export class ModulesView implements IContentRenderer {
	private handles: SignalHandle<unknown>[];
	element: HTMLElement;

	constructor(element: HTMLElement) {
		this.element = element;
		this.handles = Signal.subscribeAll([DBG.modules, DBG.unloadedModules], () =>
			this.doRender(),
		);
	}

	init(_: GroupPanelPartInitParameters): void {
		this.doRender();
	}

	private doRender(): void {
		const modules = DBG.modules.state;
		const unloadedModules = DBG.unloadedModules.state;
		const moduleRows = modules.map(moduleToRow);
		const unloadedRows = unloadedModules.map(unloadedModuleToRow);

		render(
			html`
				<section class="dump-info-panel" aria-label="Modules">
					${tableTemplate(MODULE_HEADERS, moduleRows, modules.length > 0 ? "Loaded Modules" : undefined)}
					${unloadedModules.length > 0 ? tableTemplate(UNLOADED_HEADERS, unloadedRows, "Unloaded Modules") : ""}
				</section>
			`,
			this.element,
		);
	}

	dispose(): void {
		for (const h of this.handles) h.dispose();
	}
}
