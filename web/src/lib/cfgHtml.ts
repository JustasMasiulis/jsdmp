import type { CfgNode, CfgTextSegment } from "./disassemblyGraph";

export const escapeHtml = (text: string) =>
	text.replace(/[&<>"]/g, (ch) =>
		ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : "&quot;",
	);

export const escapeAttr = (text: string) =>
	text.replace(/[&"]/g, (ch) => (ch === "&" ? "&amp;" : "&quot;"));

const pushTermSpan = (
	parts: string[],
	segment: CfgTextSegment,
	extraClass?: string,
	extraAttrs?: string,
): void => {
	parts.push('<span class="');
	parts.push(extraClass ? `${extraClass} cfg-block__term` : "cfg-block__term");
	if (segment.syntaxKind !== "plain") {
		parts.push(" cfg-block__term--syntax-");
		parts.push(segment.syntaxKind);
	}
	parts.push('"');
	if (extraAttrs) parts.push(extraAttrs);
	if (segment.term) {
		parts.push(' data-term="');
		parts.push(escapeAttr(segment.term));
		parts.push('"');
	}
	parts.push(">");
	parts.push(escapeHtml(segment.text));
	parts.push("</span>");
};

export const renderCfgBlockHtml = (node: CfgNode): string => {
	const parts: string[] = [];
	for (const line of node.lines) {
		parts.push('<div class="cfg-block__line">');
		if (line.segments.length === 0) {
			parts.push(escapeHtml(line.text));
		} else {
			for (const segment of line.segments) {
				if (segment.targetAddress !== undefined) {
					pushTermSpan(
						parts,
						segment,
						"disasm-link",
						` data-target-address="${segment.targetAddress.toString(16)}"`,
					);
				} else if (segment.clickable && segment.term) {
					pushTermSpan(parts, segment);
				} else {
					parts.push(escapeHtml(segment.text));
				}
			}
		}
		parts.push("</div>");
	}
	return parts.join("");
};
