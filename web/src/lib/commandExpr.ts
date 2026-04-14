import {
	AMD64_GPR_NAMES,
	Amd64Context,
	ARM64_GPR_NAMES,
	Arm64Context,
	type CpuContext,
} from "./cpu_context";

const AMD64_REGISTER_MAP: Record<string, (ctx: Amd64Context) => bigint> =
	Object.fromEntries([
		...AMD64_GPR_NAMES.map(
			(name, idx) => [name, (ctx: Amd64Context) => ctx.gpr(idx)] as const,
		),
		["rip", (ctx: Amd64Context) => ctx.ip],
		["rflags", (ctx: Amd64Context) => BigInt(ctx.flags)],
	]);

const ARM64_REGISTER_MAP: Record<string, (ctx: Arm64Context) => bigint> =
	Object.fromEntries([
		...ARM64_GPR_NAMES.map(
			(name, idx) => [name, (ctx: Arm64Context) => ctx.gpr(idx)] as const,
		),
		["sp", (ctx: Arm64Context) => ctx.sp],
		["pc", (ctx: Arm64Context) => ctx.ip],
	]);

class Parser {
	private pos = 0;
	private readonly src: string;
	private readonly ctx: CpuContext | null;

	constructor(src: string, ctx: CpuContext | null) {
		this.src = src;
		this.ctx = ctx;
	}

	parse(): bigint {
		this.skipWhitespace();
		if (this.pos >= this.src.length) {
			throw new Error("Empty expression");
		}
		const result = this.parseExpr();
		this.skipWhitespace();
		if (this.pos < this.src.length) {
			throw new Error(
				`Unexpected character '${this.src[this.pos]}' at position ${this.pos}`,
			);
		}
		return result;
	}

	private parseExpr(): bigint {
		let left = this.parseAtom();
		for (;;) {
			this.skipWhitespace();
			if (this.pos >= this.src.length) break;
			const ch = this.src[this.pos];
			if (ch === "+") {
				this.pos++;
				left = left + this.parseAtom();
			} else if (ch === "-") {
				this.pos++;
				left = left - this.parseAtom();
			} else {
				break;
			}
		}
		return left;
	}

	private parseAtom(): bigint {
		this.skipWhitespace();
		if (this.pos >= this.src.length) {
			throw new Error("Unexpected end of expression");
		}

		const ch = this.src[this.pos];

		// Parenthesized sub-expression
		if (ch === "(") {
			this.pos++;
			const value = this.parseExpr();
			this.skipWhitespace();
			if (this.pos >= this.src.length || this.src[this.pos] !== ")") {
				throw new Error("Missing closing parenthesis");
			}
			this.pos++;
			return value;
		}

		// 0x hex prefix
		if (
			ch === "0" &&
			this.pos + 1 < this.src.length &&
			(this.src[this.pos + 1] === "x" || this.src[this.pos + 1] === "X")
		) {
			this.pos += 2;
			const start = this.pos;
			while (this.pos < this.src.length && isHexDigit(this.src[this.pos])) {
				this.pos++;
			}
			if (this.pos === start) {
				throw new Error("Expected hex digits after 0x");
			}
			return BigInt(`0x${this.src.slice(start, this.pos)}`);
		}

		// Identifier or number starting with a digit or letter
		if (isAlphaNum(ch)) {
			const start = this.pos;
			while (this.pos < this.src.length && isAlphaNum(this.src[this.pos])) {
				this.pos++;
			}
			const token = this.src.slice(start, this.pos);

			// Check for hex suffix notation (e.g. "1a2bh")
			if (token.endsWith("h") || token.endsWith("H")) {
				const hexPart = token.slice(0, -1);
				if (hexPart.length > 0 && isAllHexDigits(hexPart)) {
					return BigInt(`0x${hexPart}`);
				}
			}

			// Register name
			if (this.ctx === null) {
				const hasReg =
					token.toLowerCase() in AMD64_REGISTER_MAP ||
					token.toLowerCase() in ARM64_REGISTER_MAP;
				if (hasReg)
					throw new Error(
						`Cannot read register '${token}': no context available`,
					);
			} else if (this.ctx instanceof Amd64Context) {
				const regFn = AMD64_REGISTER_MAP[token.toLowerCase()];
				if (regFn) return regFn(this.ctx);
			} else if (this.ctx instanceof Arm64Context) {
				const regFn = ARM64_REGISTER_MAP[token.toLowerCase()];
				if (regFn) return regFn(this.ctx);
			}

			// Pure decimal number
			if (isAllDecDigits(token)) {
				return BigInt(token);
			}

			// Bare hex digits fallback
			if (isAllHexDigits(token)) {
				return BigInt(`0x${token}`);
			}

			throw new Error(`Unknown identifier '${token}'`);
		}

		throw new Error(`Unexpected character '${ch}' at position ${this.pos}`);
	}

	private skipWhitespace(): void {
		while (this.pos < this.src.length) {
			const ch = this.src[this.pos];
			if (ch !== " " && ch !== "\t") break;
			this.pos++;
		}
	}
}

function isHexDigit(ch: string): boolean {
	return (
		(ch >= "0" && ch <= "9") ||
		(ch >= "a" && ch <= "f") ||
		(ch >= "A" && ch <= "F")
	);
}

function isAlphaNum(ch: string): boolean {
	return (
		(ch >= "0" && ch <= "9") ||
		(ch >= "a" && ch <= "z") ||
		(ch >= "A" && ch <= "Z") ||
		ch === "_"
	);
}

function isAllHexDigits(s: string): boolean {
	for (let i = 0; i < s.length; i++) {
		if (!isHexDigit(s[i])) return false;
	}
	return s.length > 0;
}

function isAllDecDigits(s: string): boolean {
	for (let i = 0; i < s.length; i++) {
		const ch = s[i];
		if (ch < "0" || ch > "9") return false;
	}
	return s.length > 0;
}

export function evaluateExpression(
	expr: string,
	ctx: CpuContext | null,
): bigint {
	return new Parser(expr.trim(), ctx).parse();
}
