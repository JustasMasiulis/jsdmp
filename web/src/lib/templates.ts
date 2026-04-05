import { html } from "lit-html";

export const EMPTY_CELL = "-";

export const labeledRow = (label: string, value: string) =>
	html`<p class="dump-info-panel__item">
		<span class="text-medium">${label}: </span> <code>${value}</code>
	</p>`;

export const rawRow = (value: string) =>
	html`<p class="dump-info-panel__item"><code>${value}</code></p>`;
