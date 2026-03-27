export const DUMP_SECTIONS = [
	"summary",
	"exception",
	"disassembly",
	"modules",
	"threads",
	"memory",
] as const;

export type DumpSection = (typeof DUMP_SECTIONS)[number];
