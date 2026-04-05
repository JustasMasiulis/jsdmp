import { describe, expect, test } from "bun:test";
import { RegisterId, registerName } from "./register";

describe("RegisterId backward compatibility", () => {
	test("AMD64 values unchanged", () => {
		expect(RegisterId.RAX).toBe(53);
		expect(RegisterId.RIP).toBe(197);
		expect(RegisterId.K7).toBe(255);
		expect(RegisterId.SP).toBe(25);
	});
});

describe("ARM64 register IDs", () => {
	test("GPR base values", () => {
		expect(RegisterId.X0).toBe(512);
		expect(RegisterId.X30).toBe(542);
		expect(RegisterId.A64_SP).toBe(543);
		expect(RegisterId.XZR).toBe(544);
	});

	test("32-bit GPR values", () => {
		expect(RegisterId.W0).toBe(545);
		expect(RegisterId.W30).toBe(575);
		expect(RegisterId.WSP).toBe(576);
		expect(RegisterId.WZR).toBe(577);
	});

	test("SIMD and special register values", () => {
		expect(RegisterId.V0).toBe(578);
		expect(RegisterId.V31).toBe(609);
		expect(RegisterId.Q0).toBe(738);
		expect(RegisterId.Q31).toBe(769);
		expect(RegisterId.PC).toBe(770);
		expect(RegisterId.NZCV).toBe(771);
		expect(RegisterId.FPCR).toBe(772);
		expect(RegisterId.FPSR).toBe(773);
	});
});

describe("registerName", () => {
	test("AMD64 names", () => {
		expect(registerName(RegisterId.NONE)).toBe("");
		expect(registerName(RegisterId.RAX)).toBe("rax");
		expect(registerName(RegisterId.RIP)).toBe("rip");
		expect(registerName(RegisterId.SP)).toBe("sp");
		expect(registerName(RegisterId.XMM0)).toBe("xmm0");
		expect(registerName(RegisterId.K7)).toBe("k7");
	});

	test("ARM64 names", () => {
		expect(registerName(RegisterId.X0)).toBe("x0");
		expect(registerName(RegisterId.X30)).toBe("x30");
		expect(registerName(RegisterId.A64_SP)).toBe("sp");
		expect(registerName(RegisterId.XZR)).toBe("xzr");
		expect(registerName(RegisterId.W0)).toBe("w0");
		expect(registerName(RegisterId.PC)).toBe("pc");
		expect(registerName(RegisterId.NZCV)).toBe("nzcv");
	});

	test("out of range returns empty string", () => {
		expect(registerName(999)).toBe("");
		expect(registerName(-1)).toBe("");
	});
});
