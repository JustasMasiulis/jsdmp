import { afterEach, describe, expect, it } from "bun:test";
import type { DebugModule } from "./debug_interface";
import type { InstrTextSegment } from "./instructionParser";
import {
	type SymbolInfo,
	SymCache,
	symbolicateSegmentGroups,
} from "./symbolication";
import { setSymbolServerUrl } from "./symbolServer";

const ORIGINAL_FETCH = globalThis.fetch;
const DEFAULT_SYMBOL_SERVER_URL = "http://localhost:9090";

type FetchCall = {
	input: RequestInfo | URL;
	init?: RequestInit;
};

const makePdbInfo = () => ({
	path: "C:\\test\\foo.pdb",
	guid: "00112233-4455-6677-8899-aabbccddeeff",
	age: 1,
});

const makeModule = (symbols: SymCache): DebugModule => ({
	address: 0x1000n,
	size: 0x1000,
	checksum: 0,
	timeDateStamp: 0,
	path: "C:\\test\\foo.dll",
	pdb: makePdbInfo(),
	symbols,
});

afterEach(() => {
	globalThis.fetch = ORIGINAL_FETCH;
	setSymbolServerUrl(DEFAULT_SYMBOL_SERVER_URL);
});

describe("SymCache.lookupMany", () => {
	it("posts one batch request and seeds positive and negative cache entries", async () => {
		const calls: FetchCall[] = [];
		globalThis.fetch = (async (input, init) => {
			calls.push({ input, init });
			return new Response(
				JSON.stringify({
					found: [{ queryRva: 0x10, name: "Target", rva: 0x10, size: 0x10 }],
					missing: [0x40],
				}),
				{
					status: 200,
					headers: { "Content-Type": "application/json" },
				},
			);
		}) as typeof fetch;

		setSymbolServerUrl("http://symbol.test");
		const cache = new SymCache(makePdbInfo());

		const results = await cache.lookupMany([0x10, 0x40, 0x10]);
		expect(calls).toHaveLength(1);
		expect(String(calls[0]?.input)).toBe(
			"http://symbol.test/pdb/foo.pdb/00112233445566778899aabbccddeeff1/nearest-batch",
		);
		expect(calls[0]?.init?.method).toBe("POST");
		expect(JSON.parse(String(calls[0]?.init?.body))).toEqual([0x10, 0x40]);
		expect(results.get(0x10)).toEqual({
			name: "Target",
			rva: 0x10,
			size: 0x10,
		} satisfies SymbolInfo);
		expect(results.get(0x40)).toBeNull();

		expect(await cache.lookup(0x18)).toEqual({
			name: "Target",
			rva: 0x10,
			size: 0x10,
		});
		expect(await cache.lookup(0x40)).toBeNull();
		expect(calls).toHaveLength(1);
	});
});

describe("symbolicateSegmentGroups", () => {
	it("reuses batched lookups per module when replacing instruction operands", async () => {
		const calls: FetchCall[] = [];
		globalThis.fetch = (async (input, init) => {
			calls.push({ input, init });
			return new Response(
				JSON.stringify({
					found: [
						{ queryRva: 0x10, name: "Target", rva: 0x10, size: 0x10 },
						{ queryRva: 0x20, name: "Data", rva: 0x20, size: 0x08 },
					],
					missing: [],
				}),
				{
					status: 200,
					headers: { "Content-Type": "application/json" },
				},
			);
		}) as typeof fetch;

		setSymbolServerUrl("http://symbol.test");
		const module = makeModule(new SymCache(makePdbInfo()));
		const branchSegments: InstrTextSegment[] = [
			{ text: "jmp ", syntaxKind: "plain" },
			{ text: "0x1010", syntaxKind: "number", targetAddress: 0x1010n },
		];
		const loadSegments: InstrTextSegment[] = [
			{ text: "mov eax, ", syntaxKind: "plain" },
			{ text: "0x1020", syntaxKind: "number", targetAddress: 0x1020n },
		];

		await symbolicateSegmentGroups(
			[
				{ segments: branchSegments, addresses: [0x1010n] },
				{ segments: loadSegments, addresses: [0x1020n] },
			],
			[module],
		);

		expect(calls).toHaveLength(1);
		expect(branchSegments[1]?.text).toBe("foo.dll!Target");
		expect(loadSegments[1]?.text).toBe("foo.dll!Data");
	});
});
