import { html, nothing, render } from "lit-html";
import type { DebugThread } from "../lib/debug_interface";
import { DBG } from "../lib/debugState";
import { fmtHex8, fmtHex16, fmtPriority } from "../lib/formatting";

export type VanillaThreadsViewOptions = {
	container: HTMLElement;
	panelId: string;
	selectedThreadId: number;
	onThreadSelect: (id: number) => void;
};

const HEADERS = [
	"Thread ID",
	"Suspended",
	"Priority",
	"TEB",
	"Stack Start",
	"Dump Flags",
	"Dump Error",
	"Exit Status",
	"Create Time",
	"Exit Time",
	"Kernel Time",
	"User Time",
	"Start Address",
	"Affinity",
];

const emptyCell = "-";

const threadToRow = (t: DebugThread): string[] => [
	String(t.id),
	t.suspendCount ? String(t.suspendCount) : emptyCell,
	t.priorityClass ? fmtPriority(t.priorityClass, t.priority) : emptyCell,
	t.teb ? fmtHex16(t.teb) : emptyCell,
	t.stack.address ? fmtHex16(t.stack.address) : emptyCell,
	t.dumpFlags ? fmtHex8(t.dumpFlags) : emptyCell,
	t.dumpError ? fmtHex8(t.dumpError) : emptyCell,
	t.exitStatus ? String(t.exitStatus) : emptyCell,
	t.createTime ? fmtHex16(t.createTime) : emptyCell,
	t.exitTime ? fmtHex16(t.exitTime) : emptyCell,
	t.kernelTime ? fmtHex16(t.kernelTime) : emptyCell,
	t.userTime ? fmtHex16(t.userTime) : emptyCell,
	t.startAddress ? fmtHex16(t.startAddress) : emptyCell,
	t.affinity ? fmtHex16(t.affinity) : emptyCell,
];

export class VanillaThreadsView {
	private threads: DebugThread[];
	private rows: string[][];
	private selectedThreadId: number;

	constructor(private options: VanillaThreadsViewOptions) {
		this.threads = DBG.dm.threads;
		this.rows = this.threads.map(threadToRow);
		this.selectedThreadId = options.selectedThreadId;
		this.doRender();
	}

	private doRender(): void {
		const { onThreadSelect } = this.options;
		render(
			html`
				<section class="dump-info-panel" aria-label="Threads">
					<div class="dump-info-panel__table-wrap">
						<table class="dump-info-table">
							<thead>
								<tr>
									${HEADERS.map((h) => html`<th>${h}</th>`)}
								</tr>
							</thead>
							<tbody>
								${
									this.threads.length === 0
										? html`<tr>
											<td colspan=${HEADERS.length}>
												<code>none</code>
											</td>
										</tr>`
										: this.threads.map(
												(thread, i) => html`
												<tr
													class=${`is-clickable${thread.id === this.selectedThreadId ? " is-selected" : ""}`}
													@click=${() => onThreadSelect(thread.id)}
												>
													${this.rows[i].map(
														(cell) => html`<td><code>${cell}</code></td>`,
													)}
												</tr>
											`,
											)
								}
							</tbody>
						</table>
					</div>
				</section>
			`,
			this.options.container,
		);
	}

	setSelectedThreadId(id: number): void {
		this.selectedThreadId = id;
		this.doRender();
	}

	dispose(): void {
		render(nothing, this.options.container);
	}
}
