import type { CfgBuildResult, CfgEdgeKind } from "./disassemblyGraph";
import { estimateNodeDimensions } from "./disassemblyGraph";
import { fetchWithRetry } from "./fetchRetry";
import { fmtHex16 } from "./formatting";
import { getSymbolServerUrl } from "./symbolServer";

const NATIVE_CFG_COMPARE_ROUTE = "/cfg/native-svg";

export const NATIVE_CFG_COMPARE_KEYBIND = "Alt+Shift+S";

export type NativeCfgCompareNode = {
	id: string;
	width: number;
	height: number;
};

export type NativeCfgCompareEdge = {
	id: string;
	from: string;
	to: string;
	kind: CfgEdgeKind;
};

export type NativeCfgComparePayload = {
	version: 1;
	anchorAddress: string;
	nodes: NativeCfgCompareNode[];
	edges: NativeCfgCompareEdge[];
};

export const buildNativeCfgComparePayload = (
	result: CfgBuildResult,
): NativeCfgComparePayload => ({
	version: 1,
	anchorAddress: `0x${fmtHex16(result.anchorAddress)}`,
	nodes: result.blocks.map((block) => {
		const dims = estimateNodeDimensions(block);
		return {
			id: block.id,
			width: dims.width,
			height: dims.height,
		};
	}),
	edges: result.edges.map((edge) => ({
		id: edge.id,
		from: edge.from,
		to: edge.to,
		kind: edge.kind,
	})),
});

export const buildNativeCfgCompareBaseName = (result: CfgBuildResult) =>
	`cfg-${fmtHex16(result.anchorAddress)}-native-compare`;

export const buildNativeCfgCompareJson = (result: CfgBuildResult) => {
	const payload = buildNativeCfgComparePayload(result);
	return {
		baseName: buildNativeCfgCompareBaseName(result),
		payload,
		jsonText: JSON.stringify(payload, null, 2),
	};
};

export const downloadTextFile = (
	fileName: string,
	text: string,
	mimeType: string,
) => {
	const blob = new Blob([text], { type: mimeType });
	const url = URL.createObjectURL(blob);
	const link = document.createElement("a");
	link.href = url;
	link.download = fileName;
	link.click();
	setTimeout(() => URL.revokeObjectURL(url), 30_000);
};

export const requestNativeCfgCompareSvg = async (jsonText: string) => {
	const base = getSymbolServerUrl().replace(/\/+$/, "");
	const response = await fetchWithRetry(`${base}${NATIVE_CFG_COMPARE_ROUTE}`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
		},
		body: jsonText,
	});

	if (!response.ok) {
		const errorText = (await response.text()).trim();
		throw new Error(
			errorText || `Native comparison request failed with ${response.status}`,
		);
	}

	return await response.text();
};
