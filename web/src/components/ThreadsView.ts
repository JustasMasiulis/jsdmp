import type {
	GroupPanelPartInitParameters,
	IContentRenderer,
} from "dockview-core";
import { html, render } from "lit-html";
import type { DebugThread } from "../lib/debug_interface";
import { DBG } from "../lib/debugState";
import { fmtHex8, fmtHex16, fmtPriority } from "../lib/formatting";
import type { SignalHandle } from "../lib/reactive";

import { EMPTY_CELL } from "../lib/templates";

const threadToRow = (t: DebugThread): string[] => [
	String(t.id),
	t.suspendCount ? String(t.suspendCount) : EMPTY_CELL,
	t.priorityClass ? fmtPriority(t.priorityClass, t.priority) : EMPTY_CELL,
	t.teb ? fmtHex16(t.teb) : EMPTY_CELL,
	t.stack.address ? fmtHex16(t.stack.address) : EMPTY_CELL,
	t.dumpFlags ? fmtHex8(t.dumpFlags) : EMPTY_CELL,
	t.dumpError ? fmtHex8(t.dumpError) : EMPTY_CELL,
	t.exitStatus ? String(t.exitStatus) : EMPTY_CELL,
	t.createTime ? fmtHex16(t.createTime) : EMPTY_CELL,
	t.exitTime ? fmtHex16(t.exitTime) : EMPTY_CELL,
	t.kernelTime ? fmtHex16(t.kernelTime) : EMPTY_CELL,
	t.userTime ? fmtHex16(t.userTime) : EMPTY_CELL,
	t.startAddress ? fmtHex16(t.startAddress) : EMPTY_CELL,
	t.affinity ? fmtHex16(t.affinity) : EMPTY_CELL,
];

export class ThreadsView implements IContentRenderer {
	private handle: SignalHandle<DebugThread | null>;
	element: HTMLElement;

	constructor(element: HTMLElement) {
		this.element = element;
		this.handle = DBG.currentThread.subscribe(() => this.doRender());
	}

	init(_: GroupPanelPartInitParameters): void {
		this.doRender();
	}

	private doRender(): void {
		const threads = DBG.threads.state;
		const rows = threads.map(threadToRow);
		const selectedId = DBG.currentThread.state?.id;
		render(
			html`
				<table class="dump-info-table" aria-label="Threads">
					<thead>
						<tr>
							<th>Thread ID</th>
							<th>Suspended</th>
							<th>Priority</th>
							<th>TEB</th>
							<th>Stack Start</th>
							<th>Dump Flags</th>
							<th>Dump Error</th>
							<th>Exit Status</th>
							<th>Create Time</th>
							<th>Exit Time</th>
							<th>Kernel Time</th>
							<th>User Time</th>
							<th>Start Address</th>
							<th>Affinity</th>
						</tr>
					</thead>
					<tbody>
						${threads.map(
							(thread, i) => html`
										<tr
											class=${`is-clickable${thread.id === selectedId ? " is-selected" : ""}`}
											@click=${() => DBG.selectThread(thread)}
										>
											${rows[i].map(
												(cell) => html`<td><code>${cell}</code></td>`,
											)}
										</tr>
									`,
						)}
					</tbody>
				</table>
			`,
			this.element,
		);
	}

	dispose(): void {
		this.handle.dispose();
	}
}
