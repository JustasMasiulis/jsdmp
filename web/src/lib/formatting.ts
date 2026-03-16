import type { MinidumpSystemInfo } from "./minidump";

const suiteMaskNames = [
	"SmallBusiness",
	"Enterprise",
	"BackOffice",
	"CommunicationServer",
	"TerminalServer",
	"SmallBusinessRestricted",
	"EmbeddedNT",
	"DataCenter",
	"SingleUserTS",
	"Personal",
	"Blade",
	"EmbeddedRestricted",
	"SecurityAppliance",
	"StorageServer",
	"ComputeServer",
	"WHServer",
	"PhoneNT",
	"MultiUserTS",
];

export function fmtProductAndSuite(sys: MinidumpSystemInfo): string {
	let res = "Product: ";
	switch (sys.productType) {
		case 1:
			res += "WinNt";
			break;
		case 2:
			res += "LanManNt";
			break;
		case 3:
			res += "Server";
			break;
		default:
			res += `unknown <${sys.productType.toString(16)}>`;
			break;
	}

	res += ", Suite:";

	if (sys.suiteMask === 0) {
		res += " <none>";
	} else {
		for (let i = 0; i < suiteMaskNames.length; i++) {
			if (sys.suiteMask & (1 << i)) {
				res += ` ${suiteMaskNames[i]}`;
			}
		}
	}

	return res;
}

export function fmtOs(sys: MinidumpSystemInfo): string {
	return `Windows ${sys.majorVersion}.${sys.minorVersion} Version ${sys.buildNumber} MP (${sys.numberOfProcessors} procs) Free ${sys.processorArchitectureName}`;
}

export function fmtHexPrefix(value: number | bigint, padLength = 0): string {
	const hex = value.toString(16).toUpperCase();
	const padded = padLength > 0 ? hex.padStart(padLength, "0") : hex;
	return `0x${padded}`;
}

export function fmtHex(value: number | bigint, padLength = 0): string {
	const hex = value.toString(16).toUpperCase();
	return padLength > 0 ? hex.padStart(padLength, "0") : hex;
}

export function fmtHex8(value: number | bigint): string {
	return fmtHex(value, 8);
}

export function fmtHex16(value: number | bigint): string {
	return fmtHex(value, 16);
}

enum ThreadPriorityClass {
	NORMAL_PRIORITY_CLASS = 0x00000020,
	IDLE_PRIORITY_CLASS = 0x00000040,
	HIGH_PRIORITY_CLASS = 0x00000080,
	REALTIME_PRIORITY_CLASS = 0x00000100,
	BELOW_NORMAL_PRIORITY_CLASS = 0x4000,
	ABOVE_NORMAL_PRIORITY_CLASS = 0x8000,
}

export function fmtPriority(priorityClass: number, priority: number): string {
	const base = [4, 6, 8, 10, 13, 24];
	const max = [15, 15, 15, 15, 15, 31];
	const min = [1, 1, 1, 1, 1, 16];

	let clasIdx: number;
	switch (priorityClass) {
		case ThreadPriorityClass.IDLE_PRIORITY_CLASS:
			clasIdx = 0;
			break;
		case ThreadPriorityClass.BELOW_NORMAL_PRIORITY_CLASS:
			clasIdx = 1;
			break;
		case ThreadPriorityClass.NORMAL_PRIORITY_CLASS:
			clasIdx = 2;
			break;
		case ThreadPriorityClass.ABOVE_NORMAL_PRIORITY_CLASS:
			clasIdx = 3;
			break;
		case ThreadPriorityClass.HIGH_PRIORITY_CLASS:
			clasIdx = 4;
			break;
		case ThreadPriorityClass.REALTIME_PRIORITY_CLASS:
			clasIdx = 5;
			break;
		default:
			return `UNK ${priorityClass} ${priority}`;
	}

	if (priority > 15 || priority < -15) {
		return `UNK ${priorityClass} ${priority}`;
	}

	let value = base[clasIdx] + priority;
	if (value > max[clasIdx]) {
		value = max[clasIdx];
	} else if (value < min[clasIdx]) {
		value = min[clasIdx];
	}

	return String(value);
}
