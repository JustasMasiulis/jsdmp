import IntervalTree from "@flatten-js/interval-tree";
import {
	type DebugModule,
	type DebugModuleSymInfo,
	findModuleForAddress,
} from "./debug_interface";
import { fetchWithRetry } from "./fetchRetry";
import { fmtHex } from "./formatting";
import type { InstrTextSegment } from "./instructionParser";
import { getSymbolServerUrl } from "./symbolServer";
import { basename } from "./utils";

export type SymbolInfo = {
	name: string;
	rva: number;
	size: number;
};

type BatchSymbolInfo = SymbolInfo & {
	queryRva: number;
};

type BatchSymbolResponse = {
	found: BatchSymbolInfo[];
	missing: number[];
};

function pdbCacheKey(info: DebugModuleSymInfo | undefined): string | null {
	if (!info) return null;
	const name = basename(info.path).toLowerCase();
	const key = info.guid.replaceAll("-", "") + info.age.toString(16);
	return `${name}/${key}`;
}

async function resolveModuleSymbol(
	mod: DebugModule,
	rva: number,
): Promise<string> {
	const sym = await mod.symbols.lookup(rva);
	return formatModuleSymbol(mod, rva, sym);
}

function formatModuleSymbol(
	mod: DebugModule,
	rva: number,
	sym: SymbolInfo | null,
): string {
	const bn = basename(mod.path);

	if (!sym) return `${bn}+0x${rva.toString(16)}`;

	const offset = rva - sym.rva;
	if (offset > 0) return `${bn}!${sym.name}+0x${offset.toString(16)}`;
	else return `${bn}!${sym.name}`;
}

export async function resolveSymbol(
	address: bigint,
	modules: readonly DebugModule[],
): Promise<string> {
	const mod = findModuleForAddress(address, modules);
	if (!mod) return fmtHex(address, 16).toLowerCase();
	return resolveModuleSymbol(mod, Number(address - mod.address));
}

function replaceAddressSegment(
	address: bigint,
	symbolText: string,
	segments: InstrTextSegment[],
): void {
	const hex = "0x" + address.toString(16);
	const idx = segments.findIndex(
		(s) => s.syntaxKind === "number" && s.text === hex,
	);
	if (idx !== -1) {
		const existing = segments[idx];
		segments[idx] = {
			text: symbolText,
			syntaxKind: "number",
			targetAddress: existing.targetAddress,
		};
	}
}

export async function symbolicateSegments(
	segments: InstrTextSegment[],
	addresses: readonly bigint[],
	modules: readonly DebugModule[],
): Promise<void> {
	await symbolicateSegmentGroups([{ segments, addresses }], modules);
}

type ServerError = { error: string };

type SegmentSymbolicationGroup = {
	segments: InstrTextSegment[];
	addresses: readonly bigint[];
};

export class SymCache {
	private readonly key: string;
	private readonly cache: IntervalTree<SymbolInfo>;
	private readonly no_symbols_cache: Set<number>;
	private readonly inflight: Map<number, Promise<SymbolInfo | null>>;
	private pdbMissing: boolean;

	constructor(pdbInfo: DebugModuleSymInfo | undefined) {
		this.key = pdbCacheKey(pdbInfo) ?? "";
		this.cache = new IntervalTree<SymbolInfo>();
		this.inflight = new Map<number, Promise<SymbolInfo | null>>();
		this.no_symbols_cache = new Set<number>();
		this.pdbMissing = !this.key;
	}

	async lookup(rva: number): Promise<SymbolInfo | null> {
		if (this.pdbMissing) return null;

		const cached = this.lookupCached(rva);
		if (cached !== undefined) return cached;

		const pending = this.inflight.get(rva);
		if (pending) return pending;

		const promise = this.fetchSymbol(rva).finally(() => {
			this.inflight.delete(rva);
		});
		this.inflight.set(rva, promise);

		const result = await promise;
		this.storeLookupResult(rva, result);
		return result;
	}

	private async fetchSymbol(rva: number): Promise<SymbolInfo | null> {
		const base = getSymbolServerUrl().replace(/\/+$/, "");
		const url = `${base}/pdb/${this.key}/nearest?rva=${rva}`;
		const response = await fetchWithRetry(url);
		const contentType = response.headers.get("content-type") ?? "";
		if (!contentType.includes("application/json")) {
			if (!response.ok) this.pdbMissing = true;
			return null;
		}

		const body = (await response.json()) as SymbolInfo | ServerError;
		if ("error" in body) {
			if (body.error === "pdb_unavailable") {
				this.pdbMissing = true;
			} else if (body.error === "no_symbol") {
				this.no_symbols_cache.add(rva);
			}
			return null;
		}
		return body;
	}

	async lookupMany(
		rvas: readonly number[],
	): Promise<Map<number, SymbolInfo | null>> {
		const results = new Map<number, SymbolInfo | null>();
		if (this.pdbMissing) return results;

		const uniqueRvas = [...new Set(rvas)];
		const pending: Promise<void>[] = [];
		const missingRvas: number[] = [];

		for (const rva of uniqueRvas) {
			const cached = this.lookupCached(rva);
			if (cached !== undefined) {
				results.set(rva, cached);
				continue;
			}

			const inflight = this.inflight.get(rva);
			if (inflight) {
				pending.push(
					inflight.then((result) => {
						results.set(rva, result);
					}),
				);
				continue;
			}

			missingRvas.push(rva);
		}

		if (missingRvas.length > 0) {
			const batchPromise = this.fetchSymbols(missingRvas).finally(() => {
				for (const rva of missingRvas) {
					this.inflight.delete(rva);
				}
			});

			for (const rva of missingRvas) {
				const rvaPromise = batchPromise.then(
					(batchResults) => batchResults.get(rva) ?? null,
				);
				this.inflight.set(rva, rvaPromise);
				pending.push(
					rvaPromise.then((result) => {
						results.set(rva, result);
					}),
				);
			}
		}

		if (pending.length > 0) {
			await Promise.all(pending);
		}
		return results;
	}

	private lookupCached(rva: number): SymbolInfo | null | undefined {
		const hits = this.cache.search([rva, rva]) as SymbolInfo[];
		if (hits.length > 0) return hits[0];
		if (this.no_symbols_cache.has(rva)) return null;
		return undefined;
	}

	private storeLookupResult(rva: number, result: SymbolInfo | null): void {
		if (!result) {
			this.no_symbols_cache.add(rva);
			return;
		}

		const hits = this.cache.search([result.rva, result.rva]) as SymbolInfo[];
		if (hits.length === 0) {
			const lo = result.rva;
			const hi = result.size > 0 ? result.rva + result.size - 1 : result.rva;
			this.cache.insert([lo, hi], result);
		}
	}

	private async fetchSymbols(
		rvas: readonly number[],
	): Promise<Map<number, SymbolInfo | null>> {
		const base = getSymbolServerUrl().replace(/\/+$/, "");
		const url = `${base}/pdb/${this.key}/nearest-batch`;
		const response = await fetchWithRetry(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(rvas),
		});
		const contentType = response.headers.get("content-type") ?? "";
		if (!contentType.includes("application/json")) {
			if (!response.ok) this.pdbMissing = true;
			return new Map();
		}

		const body = (await response.json()) as BatchSymbolResponse | ServerError;
		if ("error" in body) {
			if (body.error === "pdb_unavailable") {
				this.pdbMissing = true;
			}
			return new Map();
		}

		const results = new Map<number, SymbolInfo | null>();
		for (const rva of rvas) {
			results.set(rva, null);
		}

		for (const symbol of body.found) {
			const resolved: SymbolInfo = {
				name: symbol.name,
				rva: symbol.rva,
				size: symbol.size,
			};
			results.set(symbol.queryRva, resolved);
			this.storeLookupResult(symbol.queryRva, resolved);
		}

		for (const rva of body.missing) {
			results.set(rva, null);
			this.no_symbols_cache.add(rva);
		}

		return results;
	}
}

export async function symbolicateSegmentGroups(
	groups: readonly SegmentSymbolicationGroup[],
	modules: readonly DebugModule[],
): Promise<void> {
	const groupedByModule = new Map<
		DebugModule,
		Array<{ address: bigint; rva: number; segments: InstrTextSegment[] }>
	>();

	for (const group of groups) {
		for (const address of group.addresses) {
			const mod = findModuleForAddress(address, modules);
			if (!mod) continue;

			const replacements = groupedByModule.get(mod);
			const entry = {
				address,
				rva: Number(address - mod.address),
				segments: group.segments,
			};
			if (replacements) {
				replacements.push(entry);
			} else {
				groupedByModule.set(mod, [entry]);
			}
		}
	}

	await Promise.all(
		[...groupedByModule.entries()].map(async ([mod, replacements]) => {
			const symbols = await mod.symbols.lookupMany(
				replacements.map((replacement) => replacement.rva),
			);
			for (const replacement of replacements) {
				const symbol = symbols.get(replacement.rva) ?? null;
				const symbolText = formatModuleSymbol(mod, replacement.rva, symbol);
				replaceAddressSegment(
					replacement.address,
					symbolText,
					replacement.segments,
				);
			}
		}),
	);
}
