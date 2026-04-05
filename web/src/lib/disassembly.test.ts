/** biome-ignore-all lint/style/useTemplate: string concatenation has better performance */
import { describe, expect, test } from "bun:test";
import { readPackedHeader } from "./disassembly";

function makeView(size: number): DataView {
	return new DataView(new ArrayBuffer(size));
}

describe("readPackedHeader", () => {
	test("extracts opcode from bits 31:18", () => {
		const view = makeView(256);
		view.setUint32(0, 0xabc << 18, true);
		const header = readPackedHeader(view);
		expect(header.opcode).toBe(0xabc);
	});

	test("extracts length from bits 17:14", () => {
		const view = makeView(256);
		view.setUint32(0, 5 << 14, true);
		const header = readPackedHeader(view);
		expect(header.length).toBe(5);
	});

	test("extracts operandCount from bits 13:11", () => {
		const view = makeView(256);
		view.setUint32(0, 3 << 11, true);
		const header = readPackedHeader(view);
		expect(header.operandCount).toBe(3);
	});

	test("extracts controlFlowKind from bits 10:8", () => {
		const view = makeView(256);
		view.setUint32(0, 7 << 8, true);
		const header = readPackedHeader(view);
		expect(header.controlFlowKind).toBe(7);
	});

	test("extracts hasDirectTarget from bit 7", () => {
		const view = makeView(256);
		view.setUint32(0, 1 << 7, true);
		const header = readPackedHeader(view);
		expect(header.hasDirectTarget).toBe(true);
	});

	test("hasDirectTarget is false when bit 7 is 0", () => {
		const view = makeView(256);
		view.setUint32(0, 0, true);
		const header = readPackedHeader(view);
		expect(header.hasDirectTarget).toBe(false);
	});

	test("extracts archHeader from offset 4", () => {
		const view = makeView(256);
		view.setUint32(4, 0xdeadbeef, true);
		const header = readPackedHeader(view);
		expect(header.archHeader).toBe(0xdeadbeef);
	});

	test("extracts attributes from offset 8", () => {
		const view = makeView(256);
		view.setBigUint64(8, 0x123456789abcdef0n, true);
		const header = readPackedHeader(view);
		expect(header.attributes).toBe(0x123456789abcdef0n);
	});

	test("extracts directTarget from offset 16", () => {
		const view = makeView(256);
		view.setBigUint64(16, 0xfedcba9876543210n, true);
		const header = readPackedHeader(view);
		expect(header.directTarget).toBe(0xfedcba9876543210n);
	});

	test("parses combined word0 correctly", () => {
		const view = makeView(256);
		const opcode = 0x42;
		const length = 3;
		const operandCount = 2;
		const controlFlowKind = 1;
		const hasDirectTarget = 1;
		const word0 =
			(opcode << 18) |
			(length << 14) |
			(operandCount << 11) |
			(controlFlowKind << 8) |
			(hasDirectTarget << 7);
		view.setUint32(0, word0, true);

		const header = readPackedHeader(view);
		expect(header.opcode).toBe(0x42);
		expect(header.length).toBe(3);
		expect(header.operandCount).toBe(2);
		expect(header.controlFlowKind).toBe(1);
		expect(header.hasDirectTarget).toBe(true);
	});
});
