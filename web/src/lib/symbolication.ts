import { type DebugModule, findModuleForAddress } from "./debug_interface";
import { fetchWithRetry } from "./fetchRetry";
import { fmtHex } from "./formatting";
import type { InstrTextSegment } from "./instructionParser";
import { getSymbolServerUrl } from "./symbolServer";
import { basename } from "./utils";

export type SymbolInfo = {
	name: string;
	rva: number;
};

const symbolCache = new Map<string, Map<number, SymbolInfo | null>>();
const inflight = new Map<string, Promise<SymbolInfo | null>>();

function pdbCacheKey(mod: DebugModule): { name: string; key: string } | null {
	if (!mod.pdb) return null;
	const name = basename(mod.pdb.path).toLowerCase();
	const key = mod.pdb.guid.replaceAll("-", "") + mod.pdb.age.toString(16);
	return { name, key };
}

async function fetchSymbol(
	pdbInfo: { name: string; key: string },
	rva: number,
): Promise<SymbolInfo | null> {
	const base = getSymbolServerUrl().replace(/\/+$/, "");
	const url = `${base}/pdb/${pdbInfo.name}/${pdbInfo.key}/nearest?rva=${rva}`;
	try {
		const response = await fetchWithRetry(url);
		if (!response.ok) return null;
		return (await response.json()) as SymbolInfo;
	} catch {
		return null;
	}
}

async function lookupSymbol(
	pdbInfo: { name: string; key: string },
	rva: number,
): Promise<SymbolInfo | null> {
	const cacheKey = `${pdbInfo.name}/${pdbInfo.key}`;
	let moduleSymbols = symbolCache.get(cacheKey);
	if (moduleSymbols) {
		const cached = moduleSymbols.get(rva);
		if (cached !== undefined) return cached;
	}

	const inflightKey = `${pdbInfo.key}@${rva}`;
	const pending = inflight.get(inflightKey);
	if (pending) return pending;

	const promise = fetchSymbol(pdbInfo, rva).finally(() => {
		inflight.delete(inflightKey);
	});
	inflight.set(inflightKey, promise);
	const result = await promise;
	if (!moduleSymbols) {
		moduleSymbols = new Map();
		symbolCache.set(cacheKey, moduleSymbols);
	}
	moduleSymbols.set(rva, result);
	return result;
}

function formatSymbolResult(
	mod: DebugModule,
	rva: number,
	sym: SymbolInfo | null,
): string {
	const modName = basename(mod.path);
	if (sym) {
		const offset = rva - sym.rva;
		if (offset > 0) return `${modName}!${sym.name}+0x${offset.toString(16)}`;
		return `${modName}!${sym.name}`;
	}
	return `${modName}+0x${rva.toString(16)}`;
}

export async function resolveSymbol(
	address: bigint,
	modules: readonly DebugModule[],
): Promise<string> {
	const mod = findModuleForAddress(address, modules);
	if (!mod) return fmtHex(address, 16).toLowerCase();

	const rva = Number(address - mod.address);
	const pdbInfo = pdbCacheKey(mod);
	if (!pdbInfo) return `${basename(mod.path)}+0x${rva.toString(16)}`;

	const sym = await lookupSymbol(pdbInfo, rva);
	return formatSymbolResult(mod, rva, sym);
}

function replaceAddressSegment(
	address: bigint,
	symbolText: string,
	segments: InstrTextSegment[],
): void {
	const hex = "0x" + address.toString(16).toUpperCase();
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
		if (!findModuleForAddress(addr, modules)) continue;
		promises.push(
			resolveSymbol(addr, modules).then((sym) =>
				replaceAddressSegment(addr, sym, segments),
			),
		);
	}
	await Promise.all(promises);
}
