export class DeterministicRng {
	#s0: number;
	#s1: number;
	#s2: number;
	#s3: number;

	constructor() {
		this.#s0 = 0x853c49e6;
		this.#s1 = 0x748fea9b;
		this.#s2 = 0x4c957f2d;
		this.#s3 = 0x5851f42d;
	}

	next(): number {
		const t = this.#s1 << 9;
		const r = Math.imul((this.#s1 * 5) | 0, 7) | 0;
		const result = Math.imul((r << 7) | (r >>> 25), 9) >>> 0;
		this.#s2 ^= this.#s0;
		this.#s3 ^= this.#s1;
		this.#s1 ^= this.#s2;
		this.#s0 ^= this.#s3;
		this.#s2 ^= t;
		this.#s3 = (this.#s3 << 11) | (this.#s3 >>> 21);
		return result / 4294967296;
	}
}
