import type { InstrSyntaxKind, InstrTextSegment } from "./instructionParser";

const SYNTAX_CSS: Partial<Record<InstrSyntaxKind, string>> = {
	mnemonic: "s-m",
	number: "s-n",
	register: "s-r",
};

export type AddressNavigator = (address: bigint) => void;

export const renderSegment = (
	parent: HTMLElement,
	segment: Pick<InstrTextSegment, "text" | "syntaxKind" | "targetAddress">,
	onNavigate?: AddressNavigator,
) => {
	if (segment.targetAddress !== undefined && onNavigate) {
		const addr = segment.targetAddress;
		const span = document.createElement("span");
		span.className = "disasm-link";
		const cls = SYNTAX_CSS[segment.syntaxKind];
		if (cls) span.classList.add(cls);
		span.textContent = segment.text;
		span.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			onNavigate(addr);
		});
		parent.appendChild(span);
		return;
	}

	const cls = SYNTAX_CSS[segment.syntaxKind];
	if (cls) {
		const span = document.createElement("span");
		span.className = cls;
		span.textContent = segment.text;
		parent.appendChild(span);
	} else {
		parent.appendChild(document.createTextNode(segment.text));
	}
};

export const renderSegments = (
	parent: HTMLElement,
	segments: readonly InstrTextSegment[],
	onNavigate?: AddressNavigator,
) => {
	for (const s of segments) renderSegment(parent, s, onNavigate);
};
