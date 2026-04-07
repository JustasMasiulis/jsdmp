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
	const promises: Promise<void>[] = [];
	for (const addr of addresses) {
		const mod = findModuleForAddress(addr, modules);
		if (!mod) continue;

		promises.push(
			resolveModuleSymbol(mod, Number(addr - mod.address)).then((sym) =>
				replaceAddressSegment(addr, sym, segments),
			),
		);
	}
	await Promise.all(promises);
}

export class SymCache {
	private readonly key: string;
	private readonly cache: IntervalTree<SymbolInfo>;
	private readonly inflight: Map<string, Promise<SymbolInfo | null>>;

	constructor(pdbInfo: DebugModuleSymInfo | undefined) {
		this.key = pdbCacheKey(pdbInfo) ?? "";
		this.cache = new IntervalTree<SymbolInfo>();
		this.inflight = new Map<string, Promise<SymbolInfo | null>>();
	}

	async lookup(rva: number): Promise<SymbolInfo | null> {
		if (!this.key) return null;

		const hits = this.cache.search([rva, rva]) as SymbolInfo[];
		if (hits.length > 0) {
			return hits[0];
		}

		const inflightKey = `${this.key}${rva}`;
		const pending = this.inflight.get(inflightKey);
		if (pending) return pending;

		const promise = this.fetchSymbol(rva).finally(() => {
			this.inflight.delete(inflightKey);
		});
		this.inflight.set(inflightKey, promise);

		const result = await promise;
		if (result) {
			const lo = result.rva;
			const hi = result.size > 0 ? result.rva + result.size - 1 : result.rva;
			this.cache.insert([lo, hi], result);
		}

		return result;
	}

	private async fetchSymbol(rva: number) {
		const base = getSymbolServerUrl().replace(/\/+$/, "");
		const url = `${base}/pdb/${this.key}/nearest?rva=${rva}`;
		const response = await fetchWithRetry(url);
		if (!response.ok) return null;
		return (await response.json()) as SymbolInfo;
	}
}
