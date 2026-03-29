import type { DebugModule } from "./debug_interface";
import { PeFile } from "./pe";
import { basename } from "./utils";

const LOCAL_STORAGE_KEY = "symbolServerUrl";
const DEFAULT_SERVER_URL = "http://localhost:9090";
const PAGE_SIZE = 0x1000;
const MAX_CACHED_PAGES = 512;

// ---------------------------------------------------------------------------
// Page cache — LRU, keyed by "module/page_index"
// ---------------------------------------------------------------------------

// Map iteration order tracks insertion order, so delete+set acts as LRU touch.
const pageCache = new Map<string, Uint8Array>();
const pageInflight = new Map<string, Promise<Uint8Array | null>>();

function touchPage(key: string): void {
	const data = pageCache.get(key);
	if (data !== undefined) {
		pageCache.delete(key);
		pageCache.set(key, data);
	}
}

function evictPages(): void {
	while (pageCache.size > MAX_CACHED_PAGES) {
		// biome-ignore lint/style/noNonNullAssertion: guaranteed by the loop condition
		const oldest = pageCache.keys().next().value!;
		pageCache.delete(oldest);
	}
}

async function fetchPage(
	modCacheKey: string,
	mod: DebugModule,
	pageIndex: number,
): Promise<Uint8Array | null> {
	const pageKey = `${modCacheKey}@${pageIndex}`;

	const cached = pageCache.get(pageKey);
	if (cached) {
		touchPage(pageKey);
		return cached;
	}

	let pending = pageInflight.get(pageKey);
	if (pending) return pending;

	pending = fetchPageFromServer(mod, pageIndex, pageKey);
	pageInflight.set(pageKey, pending);
	return pending;
}

async function fetchPageFromServer(
	mod: DebugModule,
	pageIndex: number,
	pageKey: string,
): Promise<Uint8Array | null> {
	const offset = pageIndex * PAGE_SIZE;
	const base = getSymbolServerUrl().replace(/\/+$/, "");
	const name = moduleName(mod);
	const key = moduleKey(mod);
	const url = `${base}/modules/${name}/${key}?offset=${offset}&size=${PAGE_SIZE}`;
	try {
		const response = await fetch(url);
		if (!response.ok) return null;
		const buffer = await response.arrayBuffer();
		const data = new Uint8Array(buffer);
		pageCache.set(pageKey, data);
		touchPage(pageKey);
		evictPages();
		return data;
	} catch {
		return null;
	} finally {
		pageInflight.delete(pageKey);
	}
}

async function cachedRead(
	modCacheKey: string,
	mod: DebugModule,
	fileOffset: number,
	size: number,
): Promise<Uint8Array | null> {
	const startPage = Math.floor(fileOffset / PAGE_SIZE);
	const endPage = Math.floor((fileOffset + size - 1) / PAGE_SIZE);

	if (startPage === endPage) {
		const page = await fetchPage(modCacheKey, mod, startPage);
		if (!page) return null;
		const off = fileOffset - startPage * PAGE_SIZE;
		return page.subarray(off, Math.min(off + size, page.length));
	}

	const result = new Uint8Array(size);
	let written = 0;
	for (let p = startPage; p <= endPage; p++) {
		const page = await fetchPage(modCacheKey, mod, p);
		if (!page) return null;
		const pageStart = p * PAGE_SIZE;
		const srcOff = Math.max(fileOffset - pageStart, 0);
		const srcEnd = Math.min(fileOffset + size - pageStart, page.length);
		const chunk = page.subarray(srcOff, srcEnd);
		result.set(chunk, written);
		written += chunk.length;
	}
	return result.subarray(0, written);
}

// ---------------------------------------------------------------------------
// Module PeFile cache
// ---------------------------------------------------------------------------

const peFileCache = new Map<string, Promise<PeFile | null>>();

let cachedServerUrl: string | null = null;

export function getSymbolServerUrl(): string {
	if (cachedServerUrl !== null) return cachedServerUrl;
	try {
		cachedServerUrl =
			localStorage.getItem(LOCAL_STORAGE_KEY) ?? DEFAULT_SERVER_URL;
	} catch {
		cachedServerUrl = DEFAULT_SERVER_URL;
	}
	return cachedServerUrl;
}

export function setSymbolServerUrl(url: string): void {
	cachedServerUrl = url;
	try {
		localStorage.setItem(LOCAL_STORAGE_KEY, url);
	} catch {
		// localStorage unavailable
	}
}

function moduleKey(mod: DebugModule): string {
	const timestamp = mod.timeDateStamp
		.toString(16)
		.padStart(8, "0")
		.toUpperCase();
	const size = mod.size.toString(16);
	return `${timestamp}${size}`;
}

function moduleName(mod: DebugModule): string {
	return basename(mod.path).toLowerCase();
}

function moduleCacheKey(mod: DebugModule): string {
	return `${moduleName(mod)}/${moduleKey(mod)}`;
}

async function loadPeFile(mod: DebugModule): Promise<PeFile | null> {
	const base = getSymbolServerUrl().replace(/\/+$/, "");
	const name = moduleName(mod);
	const key = moduleKey(mod);
	const url = `${base}/headers/${name}/${key}`;
	try {
		const response = await fetch(url);
		if (!response.ok)
			throw new Error(
				`Failed to load PE file for module ${mod.path}: ${url} ${response.statusText}`,
			);

		const buffer = await response.arrayBuffer();
		return new PeFile(new Uint8Array(buffer));
	} catch (err) {
		console.error(
			`Failed to load PE file for module ${mod.path}: ${url} ${err}`,
		);
		return null;
	}
}

export function getModulePeFile(mod: DebugModule): Promise<PeFile | null> {
	const cacheKey = moduleCacheKey(mod);
	const existing = peFileCache.get(cacheKey);
	if (existing) return existing;

	const promise = loadPeFile(mod).catch((err) => {
		peFileCache.delete(cacheKey);
		throw err;
	});
	peFileCache.set(cacheKey, promise);
	return promise;
}

export async function readFromModuleImage(
	mod: DebugModule,
	rva: number,
	size: number,
): Promise<Uint8Array | null> {
	const cacheKey = moduleCacheKey(mod);
	const pe = await getModulePeFile(mod);
	if (!pe) return null;

	const mapping = pe.rvaToFileOffset(rva, size);
	if (!mapping) return null;

	const { fileOffset, availableSize } = mapping;

	const fromHeader = pe.readHeader(fileOffset, availableSize);
	if (fromHeader) return fromHeader;

	return cachedRead(cacheKey, mod, fileOffset, availableSize);
}
