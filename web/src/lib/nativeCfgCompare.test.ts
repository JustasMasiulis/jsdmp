import { describe, expect, it } from "bun:test";

import type { CfgBuildResult } from "./disassemblyGraph";
import {
	buildNativeCfgCompareBaseName,
	buildNativeCfgComparePayload,
} from "./nativeCfgCompare";

const sampleGraph: CfgBuildResult = {
	anchorAddress: 0x401000n,
	blocks: [
		{
			id: "block:401000",
			title: "entry",
			instructionCount: 2,
			lines: [
				{
					text: "0000000000401000  cmp eax, ebx",
					segments: [],
				},
				{
					text: "0000000000401002  jne 0x401010",
					segments: [],
				},
			],
		},
		{
			id: "block:401010",
			title: "exit",
			instructionCount: 1,
			lines: [
				{
					text: "0000000000401010  ret",
					segments: [],
				},
			],
		},
	],
	edges: [
		{
			id: "block:401000->block:401010",
			from: "block:401000",
			to: "block:401010",
			kind: "true",
		},
	],
	stats: {
		blockCount: 2,
		edgeCount: 1,
		instructionCount: 3,
		truncated: false,
	},
};

describe("native cfg compare export", () => {
	it("serializes geometry and edge kinds without block text", () => {
		const payload = buildNativeCfgComparePayload(sampleGraph);

		expect(payload).toEqual({
			version: 1,
			anchorAddress: "0x0000000000401000",
			nodes: [
				{
					id: "block:401000",
					width: 228,
					height: 44,
				},
				{
					id: "block:401010",
					width: 165,
					height: 29,
				},
			],
			edges: [
				{
					id: "block:401000->block:401010",
					from: "block:401000",
					to: "block:401010",
					kind: "true",
				},
			],
		});
		expect(JSON.stringify(payload)).not.toContain("cmp eax, ebx");
	});

	it("uses the anchor address in exported filenames", () => {
		expect(buildNativeCfgCompareBaseName(sampleGraph)).toBe(
			"cfg-0000000000401000-native-compare",
		);
	});
});
