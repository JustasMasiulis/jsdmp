export const DUMP_SECTIONS = [
	"summary",
	"exception",
	"disassembly",
	"modules",
	"threads",
	"memory",
	"command",
] as const;

export type DumpSection = (typeof DUMP_SECTIONS)[number];
