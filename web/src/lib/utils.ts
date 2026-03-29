export const assert = (condition: boolean, message: string): void => {
	if (!condition) {
		throw new Error(message);
	}
};

export const maxU64 = (a: bigint, b: bigint): bigint => {
	return a > b ? a : b;
};

export const basename = (path: string): string => {
	const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
	return idx >= 0 ? path.slice(idx + 1) : path;
};
