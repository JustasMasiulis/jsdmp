export const assert = (condition: boolean, message: string): void => {
	if (!condition) {
		throw new Error(message);
	}
};

export const maxU64 = (a: bigint, b: bigint): bigint => {
	return a > b ? a : b;
};
