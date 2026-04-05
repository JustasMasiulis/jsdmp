import type {
	GroupPanelPartInitParameters,
	IContentRenderer,
} from "dockview-core";
import { html, render } from "lit-html";
import { DBG } from "../lib/debugState";
import { fmtHex } from "../lib/formatting";
import type { MinidumpDebugExceptionInfo } from "../lib/minidump_debug_interface";
import { labeledRow } from "../lib/templates";

const parameterRows = (ei: MinidumpDebugExceptionInfo) =>
	ei.exceptionRecord.exceptionInformation.map(
		(value, index) => [String(index), fmtHex(value, 16)] as const,
	);

export class ExceptionView implements IContentRenderer {
	element: HTMLElement;

	constructor(element: HTMLElement) {
		this.element = element;
	}

	init(_: GroupPanelPartInitParameters): void {
		this.doRender();
	}

	private doRender(): void {
		const ei = DBG.exceptionInfo;
		if (!ei) {
			render(
				html`<section class="dump-info-panel" aria-label="Exception">
					<p class="dump-info-panel__item"><code>No exception information</code></p>
				</section>`,
				this.element,
			);
			return;
		}

		const params = parameterRows(ei);

		render(
			html`
				<section class="dump-info-panel" aria-label="Exception">
					${labeledRow("Exception Thread ID", String(ei.threadId))}
					${labeledRow("Exception Code", fmtHex(ei.exceptionRecord.exceptionCode, 8))}
					${labeledRow("Exception Flags", fmtHex(ei.exceptionRecord.exceptionFlags, 8))}
					${labeledRow("Exception Address", fmtHex(ei.exceptionRecord.exceptionAddress, 16))}
					${labeledRow("Exception Record", fmtHex(ei.exceptionRecord.exceptionRecord, 16))}
					${labeledRow("Exception Parameters", String(ei.exceptionRecord.numberParameters))}
					${labeledRow("Exception Context", `size=${ei.contextLocation.size}, rva=${fmtHex(ei.contextLocation.rva, 8)}`)}
					<div class="dump-info-panel__table-wrap">
						<table class="dump-info-table">
							<thead>
								<tr>
									<th>Index</th>
									<th>Value</th>
								</tr>
							</thead>
							<tbody>
								${
									params.length === 0
										? html`<tr><td colspan="2"><code>none</code></td></tr>`
										: params.map(
												([idx, val]) => html`
												<tr>
													<td><code>${idx}</code></td>
													<td><code>${val}</code></td>
												</tr>
											`,
											)
								}
							</tbody>
						</table>
					</div>
				</section>
			`,
			this.element,
		);
	}

	dispose(): void {}
}
