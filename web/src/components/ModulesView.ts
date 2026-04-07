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

const moduleToRow = (m: DebugModule) => html`
<tr>
	<td><code>${fmtHex16(m.address)}</code></td>
	<td><code>${fmtHex8(m.size)}</code></td>
	<td><code>${fmtHex8(m.checksum)}</code></td>
	<td><code>${fmtHex8(m.timeDateStamp)}</code></td>
	<td><code>${m.path || EMPTY_CELL}</code></td>
	<td><code>${m.pdb?.path || EMPTY_CELL}</code></td>
	<td><code>${m.pdb?.guid || EMPTY_CELL}</code></td>
	<td><code>${m.pdb ? String(m.pdb.age) : EMPTY_CELL}</code></td>
</tr>
`;

const unloadedModuleToRow = (m: DebugUnloadedModule) => html`
<tr>
	<td><code>${fmtHex16(m.address)}</code></td>
	<td><code>${fmtHex8(m.size)}</code></td>
	<td><code>${fmtHex8(m.checksum)}</code></td>
	<td><code>${fmtHex8(m.timeDateStamp)}</code></td>
	<td><code>${m.path || EMPTY_CELL}</code></td>
</tr>
`;

const loadedModulesTemplate = (modules: DebugModule[]) => html`
		<table class="dump-info-table">
			<thead>
				<tr>
					<th>Base</th>
					<th>Size</th>
					<th>Checksum</th>
					<th>TimeDateStamp</th>
					<th>Name</th>
					<th>PDB</th>
					<th>GUID</th>
					<th>Age</th>
				</tr>
			</thead>
			<tbody>
				${modules.map((m) => moduleToRow(m))}
			</tbody>
		</table>
`;

const unloadedModulesTemplate = (modules: DebugUnloadedModule[]) => html`
<p class="dump-info-panel__table-title text-medium">Unloaded Modules</p>
<table class="dump-info-table">
	<thead>
		<tr>
			<th>Base</th>
			<th>Size</th>
			<th>Checksum</th>
			<th>TimeDateStamp</th>
			<th>Name</th>
		</tr>
	</thead>
	<tbody>
		${modules.map((m) => unloadedModuleToRow(m))}
	</tbody>
</table>
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

		render(
			html`
				<section class="dump-info-panel" aria-label="Modules">
					${loadedModulesTemplate(modules)}
					${unloadedModulesTemplate(unloadedModules)}
				</section>
			`,
			this.element,
		);
	}

	dispose(): void {
		for (const h of this.handles) h.dispose();
	}
}
