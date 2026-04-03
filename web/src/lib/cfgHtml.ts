import type { CfgNode } from "./disassemblyGraph";

export const escapeHtml = (text: string) =>
	text.replace(/[&<>"]/g, (ch) =>
		ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : "&quot;",
	);

export const escapeAttr = (text: string) =>
	text.replace(/[&"]/g, (ch) => (ch === "&" ? "&amp;" : "&quot;"));

export const renderCfgBlockHtml = (node: CfgNode): string => {
	const parts: string[] = [];
	for (const line of node.lines) {
		parts.push('<div class="cfg-block__line">');
		if (line.segments.length === 0) {
			parts.push(escapeHtml(line.text));
		} else {
			for (const segment of line.segments) {
				if (!segment.clickable || !segment.term) {
					parts.push(escapeHtml(segment.text));
					continue;
				}
				parts.push('<span class="cfg-block__term');
				if (segment.syntaxKind !== "plain") {
					parts.push(" cfg-block__term--syntax-");
					parts.push(segment.syntaxKind);
				}
				parts.push('" data-term="');
				parts.push(escapeAttr(segment.term));
				parts.push('">');
				parts.push(escapeHtml(segment.text));
				parts.push("</span>");
			}
		}
		parts.push("</div>");
	}
	return parts.join("");
};
