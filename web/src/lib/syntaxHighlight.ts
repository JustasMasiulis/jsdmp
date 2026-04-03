import type { InstrSyntaxKind, InstrTextSegment } from "./intelFormatter";

const SYNTAX_CSS: Partial<Record<InstrSyntaxKind, string>> = {
	mnemonic: "s-m",
	number: "s-n",
	register: "s-r",
};

export const renderSegment = (
	parent: HTMLElement,
	text: string,
	syntaxKind: InstrSyntaxKind,
) => {
	const cls = SYNTAX_CSS[syntaxKind];
	if (cls) {
		const span = document.createElement("span");
		span.className = cls;
		span.textContent = text;
		parent.appendChild(span);
	} else {
		parent.appendChild(document.createTextNode(text));
	}
};

export const renderSegments = (
	parent: HTMLElement,
	segments: readonly InstrTextSegment[],
) => {
	for (const s of segments) renderSegment(parent, s.text, s.syntaxKind);
};
