import { describe, expect, test } from "bun:test";
import { AddressHistory } from "./addressHistory";

describe("AddressHistory", () => {
	test("starts empty", () => {
		const h = new AddressHistory();
		expect(h.current()).toBeNull();
		expect(h.canGoBack()).toBe(false);
		expect(h.canGoForward()).toBe(false);
	});

	test("push and current", () => {
		const h = new AddressHistory();
		h.push(100n);
		expect(h.current()).toBe(100n);
		h.push(200n);
		expect(h.current()).toBe(200n);
	});

	test("go back and forward", () => {
		const h = new AddressHistory();
		h.push(1n);
		h.push(2n);
		h.push(3n);
		expect(h.canGoBack()).toBe(true);
		expect(h.goBack()).toBe(2n);
		expect(h.goBack()).toBe(1n);
		expect(h.canGoBack()).toBe(false);
		expect(h.goBack()).toBeNull();
		expect(h.canGoForward()).toBe(true);
		expect(h.goForward()).toBe(2n);
		expect(h.goForward()).toBe(3n);
		expect(h.canGoForward()).toBe(false);
		expect(h.goForward()).toBeNull();
	});

	test("push truncates forward entries", () => {
		const h = new AddressHistory();
		h.push(1n);
		h.push(2n);
		h.push(3n);
		h.goBack();
		h.goBack();
		h.push(10n);
		expect(h.current()).toBe(10n);
		expect(h.canGoForward()).toBe(false);
		expect(h.canGoBack()).toBe(true);
		expect(h.goBack()).toBe(1n);
	});

	test("deduplicates consecutive pushes", () => {
		const h = new AddressHistory();
		h.push(5n);
		h.push(5n);
		h.push(5n);
		expect(h.canGoBack()).toBe(false);
		expect(h.current()).toBe(5n);
	});

	test("clear resets state", () => {
		const h = new AddressHistory();
		h.push(1n);
		h.push(2n);
		h.clear();
		expect(h.current()).toBeNull();
		expect(h.canGoBack()).toBe(false);
		expect(h.canGoForward()).toBe(false);
	});

	test("respects max entries", () => {
		const h = new AddressHistory();
		for (let i = 0; i < 100; i++) {
			h.push(BigInt(i));
		}
		expect(h.current()).toBe(99n);
		let count = 0;
		while (h.canGoBack()) {
			h.goBack();
			count++;
		}
		expect(count).toBe(63);
	});
});
