import { describe, expect, it } from "bun:test";
import { Arm64Context, CONTEXT_ARM64 } from "./cpu_context";

function makeArm64Buffer(): ArrayBuffer {
	const buf = new ArrayBuffer(0x310);
	const dv = new DataView(buf);
	dv.setUint32(0x0, CONTEXT_ARM64, true);
	dv.setUint32(0x4, 0x60000000, true);
	dv.setBigUint64(0x08, 0x1111111111111111n, true);
	dv.setBigUint64(0x08 + 28 * 8, 0x2828282828282828n, true);
	dv.setBigUint64(0xf0, 0x2929292929292929n, true);
	dv.setBigUint64(0xf8, 0x3030303030303030n, true);
	dv.setBigUint64(0x100, 0xaaaaaaaaaaaaaaaan, true);
	dv.setBigUint64(0x108, 0xbbbbbbbbbbbbbbbbn, true);
	dv.setBigUint64(0x110, 0xccccccccccccccccn, true);
	dv.setBigUint64(0x118, 0xddddddddddddddddn, true);
	return buf;
}

describe("Arm64Context", () => {
	it("should throw on invalid context flags", () => {
		const buf = new ArrayBuffer(0x310);
		expect(() => new Arm64Context(buf)).toThrow("Invalid context flags");
	});

	it("should construct from ArrayBuffer with valid flags", () => {
		const buf = makeArm64Buffer();
		const ctx = new Arm64Context(buf, 0x1000n);
		expect(ctx.address).toBe(0x1000n);
		expect(ctx.context_flags).toBe(CONTEXT_ARM64);
	});

	it("should read cpsr", () => {
		const ctx = new Arm64Context(makeArm64Buffer());
		expect(ctx.cpsr).toBe(0x60000000);
	});

	it("should read and write ip (PC)", () => {
		const ctx = new Arm64Context(makeArm64Buffer());
		expect(ctx.ip).toBe(0xbbbbbbbbbbbbbbbbn);
		ctx.ip = 0x42n;
		expect(ctx.ip).toBe(0x42n);
	});

	it("should read and write sp", () => {
		const ctx = new Arm64Context(makeArm64Buffer());
		expect(ctx.sp).toBe(0xaaaaaaaaaaaaaaaan);
		ctx.sp = 0x99n;
		expect(ctx.sp).toBe(0x99n);
	});

	it("should read x0", () => {
		const ctx = new Arm64Context(makeArm64Buffer());
		expect(ctx.gpr(0)).toBe(0x1111111111111111n);
	});

	it("should read x28", () => {
		const ctx = new Arm64Context(makeArm64Buffer());
		expect(ctx.gpr(28)).toBe(0x2828282828282828n);
	});

	it("should read fp (x29) and lr (x30)", () => {
		const ctx = new Arm64Context(makeArm64Buffer());
		expect(ctx.gpr(29)).toBe(0x2929292929292929n);
		expect(ctx.gpr(30)).toBe(0x3030303030303030n);
	});

	it("should write and read back gpr", () => {
		const ctx = new Arm64Context(makeArm64Buffer());
		ctx.setGpr(5, 0x55n);
		expect(ctx.gpr(5)).toBe(0x55n);
		ctx.setGpr(29, 0x29n);
		expect(ctx.gpr(29)).toBe(0x29n);
		ctx.setGpr(30, 0x30n);
		expect(ctx.gpr(30)).toBe(0x30n);
	});

	it("should reject out-of-range gpr index", () => {
		const ctx = new Arm64Context(makeArm64Buffer());
		expect(() => ctx.gpr(31)).toThrow();
		expect(() => ctx.gpr(-1)).toThrow();
	});

	it("should read simd registers", () => {
		const ctx = new Arm64Context(makeArm64Buffer());
		const [lo, hi] = ctx.simd(0);
		expect(lo).toBe(0xccccccccccccccccn);
		expect(hi).toBe(0xddddddddddddddddn);
	});

	it("should write and read back simd registers", () => {
		const ctx = new Arm64Context(makeArm64Buffer());
		ctx.setSimd(15, 0xaan, 0xbbn);
		const [lo, hi] = ctx.simd(15);
		expect(lo).toBe(0xaan);
		expect(hi).toBe(0xbbn);
	});

	it("should reject out-of-range simd index", () => {
		const ctx = new Arm64Context(makeArm64Buffer());
		expect(() => ctx.simd(32)).toThrow();
		expect(() => ctx.simd(-1)).toThrow();
	});

	it("should clone independently", () => {
		const ctx = new Arm64Context(makeArm64Buffer(), 0x5000n);
		const cloned = ctx.clone();
		expect(cloned.address).toBe(0x5000n);
		expect(cloned.ip).toBe(ctx.ip);
		cloned.ip = 0x999n;
		expect(ctx.ip).not.toBe(0x999n);
	});

	it("should construct from Uint8Array view", () => {
		const buf = makeArm64Buffer();
		const view = new Uint8Array(buf);
		const ctx = new Arm64Context(view);
		expect(ctx.context_flags).toBe(CONTEXT_ARM64);
	});
});
