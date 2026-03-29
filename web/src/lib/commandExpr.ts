import type { Context } from "./cpu_context";

const REGISTER_MAP: Record<string, (ctx: Context) => bigint> = {
	rax: (ctx) => ctx.gpr(0),
	rcx: (ctx) => ctx.gpr(1),
	rdx: (ctx) => ctx.gpr(2),
	rbx: (ctx) => ctx.gpr(3),
	rsp: (ctx) => ctx.gpr(4),
	rbp: (ctx) => ctx.gpr(5),
	rsi: (ctx) => ctx.gpr(6),
	rdi: (ctx) => ctx.gpr(7),
	r8: (ctx) => ctx.gpr(8),
	r9: (ctx) => ctx.gpr(9),
	r10: (ctx) => ctx.gpr(10),
	r11: (ctx) => ctx.gpr(11),
	r12: (ctx) => ctx.gpr(12),
	r13: (ctx) => ctx.gpr(13),
	r14: (ctx) => ctx.gpr(14),
	r15: (ctx) => ctx.gpr(15),
	rip: (ctx) => ctx.ip,
	rflags: (ctx) => BigInt(ctx.flags),
};

class Parser {
	private pos = 0;
	private readonly src: string;
	private readonly ctx: Context | null;

	constructor(src: string, ctx: Context | null) {
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
			const regFn = REGISTER_MAP[token.toLowerCase()];
			if (regFn) {
				if (this.ctx === null) {
					throw new Error(
						`Cannot read register '${token}': no context available`,
					);
				}
				return regFn(this.ctx);
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

export function evaluateExpression(expr: string, ctx: Context | null): bigint {
	return new Parser(expr.trim(), ctx).parse();
}
