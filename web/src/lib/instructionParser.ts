/** biome-ignore-all lint/style/useTemplate: string concatenation has better performance */

export type InstrSyntaxKind =
	| "plain"
	| "mnemonic"
	| "number"
	| "register"
	| "keyword";

export type InstrTextSegment = {
	text: string;
	syntaxKind: InstrSyntaxKind;
	targetAddress?: bigint;
};

export const seg = (
	text: string,
	syntaxKind: InstrSyntaxKind = "plain",
): InstrTextSegment => ({ text, syntaxKind });

export const joinSegmentText = (
	segments: readonly { text: string }[],
): string => {
	let result = "";
	for (const s of segments) result += s.text;
	return result;
};

const REGISTERS = new Set<string>();
for (const r of [
	"rax",
	"rbx",
	"rcx",
	"rdx",
	"rsp",
	"rbp",
	"rsi",
	"rdi",
	"eax",
	"ebx",
	"ecx",
	"edx",
	"esp",
	"ebp",
	"esi",
	"edi",
	"ax",
	"bx",
	"cx",
	"dx",
	"sp",
	"bp",
	"si",
	"di",
	"al",
	"bl",
	"cl",
	"dl",
	"ah",
	"bh",
	"ch",
	"dh",
	"spl",
	"bpl",
	"sil",
	"dil",
])
	REGISTERS.add(r);
for (let i = 8; i <= 15; i++) {
	REGISTERS.add("r" + i);
	REGISTERS.add("r" + i + "d");
	REGISTERS.add("r" + i + "w");
	REGISTERS.add("r" + i + "b");
}
for (let i = 0; i <= 31; i++) {
	REGISTERS.add("xmm" + i);
	REGISTERS.add("ymm" + i);
	REGISTERS.add("zmm" + i);
}
for (let i = 0; i <= 7; i++) {
	REGISTERS.add("st(" + i + ")");
	REGISTERS.add("mm" + i);
	REGISTERS.add("k" + i);
	REGISTERS.add("tmm" + i);
}
for (const r of [
	"cs",
	"ds",
	"es",
	"fs",
	"gs",
	"ss",
	"rip",
	"eip",
	"rflags",
	"eflags",
	"flags",
])
	REGISTERS.add(r);
for (let i = 0; i <= 15; i++) REGISTERS.add("cr" + i);
for (let i = 0; i <= 7; i++) REGISTERS.add("dr" + i);
for (let i = 0; i <= 30; i++) {
	REGISTERS.add("x" + i);
	REGISTERS.add("w" + i);
	REGISTERS.add("b" + i);
	REGISTERS.add("h" + i);
	REGISTERS.add("s" + i);
	REGISTERS.add("d" + i);
	REGISTERS.add("q" + i);
	REGISTERS.add("v" + i);
}
for (const r of ["xzr", "wzr", "sp", "wsp"]) REGISTERS.add(r);

const KEYWORDS = new Set([
	"byte",
	"word",
	"dword",
	"fword",
	"qword",
	"tbyte",
	"oword",
	"xmmword",
	"ymmword",
	"zmmword",
	"ptr",
	"far",
	"near",
	"lsl",
	"lsr",
	"asr",
	"ror",
	"rrx",
	"msl",
	"uxtb",
	"uxth",
	"uxtw",
	"uxtx",
	"sxtb",
	"sxth",
	"sxtw",
	"sxtx",
]);

const PREFIXES = new Set([
	"lock",
	"rep",
	"repe",
	"repz",
	"repne",
	"repnz",
	"bnd",
	"notrack",
	"xacquire",
	"xrelease",
]);

function classifyToken(token: string): InstrSyntaxKind {
	if (REGISTERS.has(token)) return "register";
	if (KEYWORDS.has(token)) return "keyword";
	return "plain";
}

function tryMatchAddress(
	text: string,
	directTarget: bigint | null,
	ripTargets: readonly bigint[],
): bigint | undefined {
	let hex = text;
	if (hex.startsWith("#")) hex = hex.slice(1);
	if (hex.startsWith("-")) return undefined;
	if (!hex.startsWith("0x") && !hex.startsWith("0X")) return undefined;
	let value: bigint;
	try {
		value = BigInt(hex);
	} catch {
		return undefined;
	}
	if (directTarget !== null && value === directTarget) return directTarget;
	for (const t of ripTargets) {
		if (value === t) return t;
	}
	return undefined;
}

function splitMnemonicAndOperands(text: string): [string, string] {
	let pos = 0;
	while (pos < text.length) {
		const spaceIdx = text.indexOf(" ", pos);
		if (spaceIdx === -1) return [text, ""];
		const word = text.substring(pos, spaceIdx);
		if (!PREFIXES.has(word)) {
			return [text.substring(0, spaceIdx), text.substring(spaceIdx + 1)];
		}
		pos = spaceIdx + 1;
	}
	return [text, ""];
}

function isHexChar(ch: string): boolean {
	return /[0-9a-fA-F]/.test(ch);
}

function isWordChar(ch: string): boolean {
	return /[a-zA-Z0-9_()]/.test(ch);
}

function isWordStart(ch: string): boolean {
	return /[a-zA-Z_]/.test(ch);
}

function tokenizeOperands(
	text: string,
	directTarget: bigint | null,
	ripTargets: readonly bigint[],
): InstrTextSegment[] {
	const out: InstrTextSegment[] = [];
	let i = 0;

	while (i < text.length) {
		const ch = text[i];

		if (ch === " " || ch === "\t") {
			let j = i + 1;
			while (j < text.length && (text[j] === " " || text[j] === "\t")) j++;
			out.push(seg(text.substring(i, j)));
			i = j;
			continue;
		}

		if (ch === "#") {
			let j = i + 1;
			if (j < text.length && text[j] === "-") j++;
			if (
				j + 1 < text.length &&
				text[j] === "0" &&
				(text[j + 1] === "x" || text[j + 1] === "X")
			) {
				j += 2;
				while (j < text.length && isHexChar(text[j])) j++;
				const token = text.substring(i, j);
				const s = seg(token, "number");
				const addr = tryMatchAddress(token, directTarget, ripTargets);
				if (addr !== undefined) s.targetAddress = addr;
				out.push(s);
				i = j;
				continue;
			}
			if (j < text.length && /[0-9]/.test(text[j])) {
				while (j < text.length && /[0-9]/.test(text[j])) j++;
				out.push(seg(text.substring(i, j), "number"));
				i = j;
				continue;
			}
			out.push(seg("#"));
			i++;
			continue;
		}

		if (
			ch === "-" &&
			i + 2 < text.length &&
			text[i + 1] === "0" &&
			(text[i + 2] === "x" || text[i + 2] === "X")
		) {
			let j = i + 3;
			while (j < text.length && isHexChar(text[j])) j++;
			out.push(seg(text.substring(i, j), "number"));
			i = j;
			continue;
		}

		if (
			ch === "0" &&
			i + 1 < text.length &&
			(text[i + 1] === "x" || text[i + 1] === "X")
		) {
			let j = i + 2;
			while (j < text.length && isHexChar(text[j])) j++;
			const token = text.substring(i, j);
			const s = seg(token, "number");
			const addr = tryMatchAddress(token, directTarget, ripTargets);
			if (addr !== undefined) s.targetAddress = addr;
			out.push(s);
			i = j;
			continue;
		}

		if (/[0-9]/.test(ch)) {
			let j = i + 1;
			while (j < text.length && /[0-9]/.test(text[j])) j++;
			out.push(seg(text.substring(i, j), "number"));
			i = j;
			continue;
		}

		if (isWordStart(ch)) {
			let j = i + 1;
			while (j < text.length && isWordChar(text[j])) j++;
			const token = text.substring(i, j);
			out.push(seg(token, classifyToken(token)));
			i = j;
			continue;
		}

		out.push(seg(ch));
		i++;
	}

	return out;
}

export function parseInstructionText(
	text: string,
	directTarget: bigint | null,
	ripTargets: readonly bigint[],
): { mnemonic: string; operandSegments: InstrTextSegment[] } {
	const [mnemonic, operandText] = splitMnemonicAndOperands(text);
	if (!operandText) return { mnemonic, operandSegments: [] };
	return {
		mnemonic,
		operandSegments: tokenizeOperands(operandText, directTarget, ripTargets),
	};
}
