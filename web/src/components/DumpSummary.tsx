import { For, type ParentComponent } from "solid-js";
import type { DebugDisassemblyView } from "../lib/disassembly";
import {
	fmtHex,
	fmtOs,
	fmtPriority,
	fmtProductAndSuite,
} from "../lib/formatting";
import {
	MiniDumpStreamType,
	type MinidumpAssociatedThread,
	type MinidumpCodeViewInfo,
	type MinidumpExceptionStream,
	type MinidumpMemory64Range,
	type MinidumpMemoryRangeMatch,
	type MinidumpMemoryReadView,
	type MinidumpMiscInfo,
	type MinidumpModule,
	type MinidumpSystemInfo,
	type MinidumpUnloadedModule,
} from "../lib/minidump";

export type ParsedDumpInfo = {
	checksum: number;
	timestamp: number;
	flags: bigint;
	streamCount: number;
	streamTypes: number[];
	systemInfo: MinidumpSystemInfo | null;
	miscInfo: MinidumpMiscInfo | null;
	exceptionStream: MinidumpExceptionStream | null;
	associatedThreads: MinidumpAssociatedThread[] | null;
	moduleList: MinidumpModule[] | null;
	unloadedModuleList: MinidumpUnloadedModule[] | null;
	memoryRanges: MinidumpMemory64Range[];
	readMemoryAt: (address: bigint, size: number) => Uint8Array | null;
	readMemoryViewAt: (
		address: bigint,
		size: number,
		hintRangeIndex?: number,
	) => MinidumpMemoryReadView | null;
	findMemoryRangeAt: (
		address: bigint,
		hintRangeIndex?: number,
	) => MinidumpMemoryRangeMatch | null;
	debugView: DebugDisassemblyView | null;
};

export type DumpSection =
	| "summary"
	| "exception"
	| "disassembly"
	| "modules"
	| "threads"
	| "memory";

type DumpSummaryProps = {
	dumpInfo: ParsedDumpInfo;
	sections?: readonly DumpSection[];
};

const Row: ParentComponent<{ label: string }> = (props) => (
	<p class="dump-info-panel__item">
		<span class="text-medium">{props.label}:</span>{" "}
		<code>{props.children}</code>
	</p>
);

const RawRow: ParentComponent<{}> = (props) => (
	<p class="dump-info-panel__item">
		<code>{props.children}</code>
	</p>
);

const formatTimestamp = (timestamp: number) => {
	if (!timestamp) return "0 (unset)";
	const iso = new Date(timestamp * 1000).toISOString();
	return `${timestamp} (${iso})`;
};

const formatSeconds = (value: number) => `${value} sec`;

const getStreamTypeName = (streamType: number) =>
	MiniDumpStreamType[streamType] ?? `Unknown(${streamType})`;

const formatBytes = (value: bigint) => `${value.toString()} B`;

type MemoryListSummary = {
	rangeCount: number;
	totalBytes: bigint;
	startAddress: bigint;
	endAddressExclusive: bigint;
};

const summarizeMemoryList = (
	memoryRanges: MinidumpMemory64Range[],
): MemoryListSummary | null => {
	const ranges = [
		...memoryRanges.map((range) => ({
			start: range.address,
			size: range.dataSize,
		})),
	];

	if (ranges.length === 0) {
		return null;
	}

	let totalBytes = 0n;
	let startAddress = ranges[0].start;
	let endAddressExclusive = startAddress + ranges[0].size;

	for (const range of ranges) {
		const rangeEnd = range.start + range.size;
		totalBytes += range.size;
		if (range.start < startAddress) {
			startAddress = range.start;
		}
		if (rangeEnd > endAddressExclusive) {
			endAddressExclusive = rangeEnd;
		}
	}

	return {
		rangeCount: ranges.length,
		totalBytes,
		startAddress,
		endAddressExclusive,
	};
};

type DumpTableProps = {
	title: string;
	headers: string[];
	rows: string[][];
};

const DumpTable = (props: DumpTableProps) => (
	<div class="dump-info-panel__table-wrap">
		<p class="dump-info-panel__table-title text-medium">{props.title}</p>
		<table class="dump-info-table">
			<thead>
				<tr>
					<For each={props.headers}>{(header) => <th>{header}</th>}</For>
				</tr>
			</thead>
			<tbody>
				{props.rows.length > 0 ? (
					<For each={props.rows}>
						{(row) => (
							<tr>
								<For each={row}>
									{(cell) => (
										<td>
											<code>{cell}</code>
										</td>
									)}
								</For>
							</tr>
						)}
					</For>
				) : (
					<tr>
						<td colSpan={props.headers.length}>
							<code>none</code>
						</td>
					</tr>
				)}
			</tbody>
		</table>
	</div>
);

const emptyCell = "-";

const buildAssociatedRows = (
	associatedThreads: MinidumpAssociatedThread[] | null,
): string[][] =>
	(associatedThreads ?? []).map((associated) => {
		const thread = associated.thread;
		const threadInfo = associated.threadInfo;
		return [
			String(associated.threadId),
			thread ? String(thread.suspendCount) : emptyCell,
			thread ? fmtPriority(thread.priorityClass, thread.priority) : emptyCell,
			thread ? fmtHex(thread.teb, 16) : emptyCell,
			thread ? fmtHex(thread.stack.startOfMemoryRange, 16) : emptyCell,
			thread ? String(thread.stack.location.dataSize) : emptyCell,
			thread ? fmtHex(thread.stack.location.rva, 8) : emptyCell,
			thread ? String(thread.threadContext.dataSize) : emptyCell,
			thread ? fmtHex(thread.threadContext.rva, 8) : emptyCell,
			threadInfo ? fmtHex(threadInfo.dumpFlags, 8) : emptyCell,
			threadInfo ? fmtHex(threadInfo.dumpError, 8) : emptyCell,
			threadInfo ? String(threadInfo.exitStatus) : emptyCell,
			threadInfo ? fmtHex(threadInfo.createTime, 16) : emptyCell,
			threadInfo ? fmtHex(threadInfo.exitTime, 16) : emptyCell,
			threadInfo ? fmtHex(threadInfo.kernelTime, 16) : emptyCell,
			threadInfo ? fmtHex(threadInfo.userTime, 16) : emptyCell,
			threadInfo ? fmtHex(threadInfo.startAddress, 16) : emptyCell,
			threadInfo ? fmtHex(threadInfo.affinity, 16) : emptyCell,
		];
	});

const buildExceptionParameterRows = (
	exceptionStream: MinidumpExceptionStream | null,
): string[][] =>
	(exceptionStream?.exceptionRecord.exceptionInformation ?? []).map(
		(value, index) => [String(index), fmtHex(value, 16)],
	);

const buildCodeViewColumns = (
	codeViewInfo: MinidumpCodeViewInfo | null,
): [string, string, string, string] => {
	if (!codeViewInfo) {
		return [emptyCell, emptyCell, emptyCell, emptyCell];
	}

	switch (codeViewInfo.format) {
		case "RSDS":
			return [
				"RSDS",
				codeViewInfo.pdbFileName || emptyCell,
				codeViewInfo.guid,
				String(codeViewInfo.age),
			];
		case "NB10":
			return [
				"NB10",
				codeViewInfo.pdbFileName || emptyCell,
				`${fmtHex(codeViewInfo.timestamp, 8)} @ ${fmtHex(codeViewInfo.offset, 8)}`,
				String(codeViewInfo.age),
			];
		case "unknown":
			return [
				codeViewInfo.signature,
				emptyCell,
				fmtHex(codeViewInfo.rawSignature, 8),
				emptyCell,
			];
		case "invalid":
			return ["invalid", codeViewInfo.error, emptyCell, emptyCell];
	}
};

const buildModuleRows = (moduleList: MinidumpModule[] | null): string[][] =>
	(moduleList ?? []).map((module) => {
		const [cvFormat, cvPdb, cvIdentifier, cvAge] = buildCodeViewColumns(
			module.codeViewInfo,
		);
		return [
			fmtHex(module.baseOfImage, 16),
			fmtHex(module.sizeOfImage, 8),
			fmtHex(module.checkSum, 8),
			fmtHex(module.timeDateStamp, 8),
			module.moduleName || emptyCell,
			fmtHex(module.cvRecord.dataSize, 8),
			cvFormat,
			cvPdb,
			cvIdentifier,
			cvAge,
			fmtHex(module.miscRecord.dataSize, 8),
			fmtHex(module.miscRecord.rva, 8),
		];
	});

const buildUnloadedModuleRows = (
	unloadedModuleList: MinidumpUnloadedModule[] | null,
): string[][] =>
	(unloadedModuleList ?? []).map((module) => [
		fmtHex(module.baseOfImage, 16),
		fmtHex(module.sizeOfImage, 8),
		fmtHex(module.checkSum, 8),
		fmtHex(module.timeDateStamp, 8),
		module.moduleName || emptyCell,
	]);

const resolveDisassemblyStatusLabel = (
	status: DebugDisassemblyView["status"],
) => {
	switch (status) {
		case "ok":
			return "Ready";
		case "unsupported_arch":
			return "Unsupported Architecture";
		case "missing_context":
			return "Context Missing";
		case "missing_memory":
			return "Memory Missing";
		case "decode_error":
			return "Decode Error";
	}
};

export default function DumpSummary(props: DumpSummaryProps) {
	const associatedRows = buildAssociatedRows(props.dumpInfo.associatedThreads);
	const exceptionParameterRows = buildExceptionParameterRows(
		props.dumpInfo.exceptionStream,
	);
	const moduleRows = buildModuleRows(props.dumpInfo.moduleList);
	const unloadedModuleRows = buildUnloadedModuleRows(
		props.dumpInfo.unloadedModuleList,
	);
	const memoryListSummary = summarizeMemoryList(
		props.dumpInfo.memoryRanges ?? [],
	);
	const mergedThreadCount = associatedRows.length;
	const debugView = props.dumpInfo.debugView;
	const hasSection = (section: DumpSection) =>
		props.sections ? props.sections.includes(section) : true;

	return (
		<section class="dump-info-panel" aria-label="Dump details">
			{hasSection("summary") ? (
				<>
					<h2 class="dump-info-panel__title m0">Dump Summary</h2>
					<Row label="Checksum">{fmtHex(props.dumpInfo.checksum, 8)}</Row>
					<Row label="Timestamp">
						{formatTimestamp(props.dumpInfo.timestamp)}
					</Row>
					<Row label="Flags">{fmtHex(props.dumpInfo.flags, 16)}</Row>
					<Row label="Streams">{props.dumpInfo.streamCount}</Row>
					<Row label="Stream Types">
						{props.dumpInfo.streamTypes.length > 0
							? props.dumpInfo.streamTypes.map(getStreamTypeName).join(", ")
							: "none"}
					</Row>
					{props.dumpInfo.systemInfo ? (
						<div class="dump-info-panel__table-wrap">
							<RawRow>{fmtOs(props.dumpInfo.systemInfo)}</RawRow>
							<RawRow>{fmtProductAndSuite(props.dumpInfo.systemInfo)}</RawRow>

							<Row label="CPU Revision">
								level {props.dumpInfo.systemInfo.processorLevel}, rev{" "}
								{fmtHex(props.dumpInfo.systemInfo.processorRevision, 4)}
							</Row>
							{props.dumpInfo.systemInfo.cpu.type === "x86" ? (
								<Row label="CPU Vendor">
									{props.dumpInfo.systemInfo.cpu.vendorId || "unknown"}
								</Row>
							) : (
								<Row label="CPU Features">
									{fmtHex(
										props.dumpInfo.systemInfo.cpu.processorFeatures[0],
										16,
									)}
									,{" "}
									{fmtHex(
										props.dumpInfo.systemInfo.cpu.processorFeatures[1],
										16,
									)}
								</Row>
							)}
						</div>
					) : null}

					{props.dumpInfo.miscInfo ? (
						<>
							<Row label="MiscInfo Size">
								{props.dumpInfo.miscInfo.sizeOfInfo}
							</Row>
							<Row label="MiscInfo Flags1">
								{fmtHex(props.dumpInfo.miscInfo.flags1, 8)}
							</Row>
							{props.dumpInfo.miscInfo.processId !== null ? (
								<Row label="Process ID">
									{props.dumpInfo.miscInfo.processId}
								</Row>
							) : null}
							{props.dumpInfo.miscInfo.processCreateTime !== null ? (
								<Row label="Process Create Time">
									{formatTimestamp(props.dumpInfo.miscInfo.processCreateTime)}
								</Row>
							) : null}
							{props.dumpInfo.miscInfo.processUserTime !== null ? (
								<Row label="Process User Time">
									{formatSeconds(props.dumpInfo.miscInfo.processUserTime)}
								</Row>
							) : null}
							{props.dumpInfo.miscInfo.processKernelTime !== null ? (
								<Row label="Process Kernel Time">
									{formatSeconds(props.dumpInfo.miscInfo.processKernelTime)}
								</Row>
							) : null}
							{props.dumpInfo.miscInfo.processorMaxMhz !== null ? (
								<Row label="CPU Max MHz">
									{props.dumpInfo.miscInfo.processorMaxMhz}
								</Row>
							) : null}
							{props.dumpInfo.miscInfo.processorCurrentMhz !== null ? (
								<Row label="CPU Current MHz">
									{props.dumpInfo.miscInfo.processorCurrentMhz}
								</Row>
							) : null}
							{props.dumpInfo.miscInfo.processorMhzLimit !== null ? (
								<Row label="CPU MHz Limit">
									{props.dumpInfo.miscInfo.processorMhzLimit}
								</Row>
							) : null}
							{props.dumpInfo.miscInfo.processorMaxIdleState !== null ? (
								<Row label="CPU Max Idle State">
									{props.dumpInfo.miscInfo.processorMaxIdleState}
								</Row>
							) : null}
							{props.dumpInfo.miscInfo.processorCurrentIdleState !== null ? (
								<Row label="CPU Current Idle State">
									{props.dumpInfo.miscInfo.processorCurrentIdleState}
								</Row>
							) : null}
						</>
					) : null}
				</>
			) : null}

			{hasSection("exception") && props.dumpInfo.exceptionStream ? (
				<>
					<Row label="Exception Thread ID">
						{props.dumpInfo.exceptionStream.threadId}
					</Row>
					<Row label="Exception Code">
						{fmtHex(
							props.dumpInfo.exceptionStream.exceptionRecord.exceptionCode,
							8,
						)}
					</Row>
					<Row label="Exception Flags">
						{fmtHex(
							props.dumpInfo.exceptionStream.exceptionRecord.exceptionFlags,
							8,
						)}
					</Row>
					<Row label="Exception Address">
						{fmtHex(
							props.dumpInfo.exceptionStream.exceptionRecord.exceptionAddress,
							16,
						)}
					</Row>
					<Row label="Exception Record">
						{fmtHex(
							props.dumpInfo.exceptionStream.exceptionRecord.exceptionRecord,
							16,
						)}
					</Row>
					<Row label="Exception Parameters">
						{props.dumpInfo.exceptionStream.exceptionRecord.numberParameters}
					</Row>
					<Row label="Exception Context">
						size={props.dumpInfo.exceptionStream.threadContext.dataSize}, rva=
						{fmtHex(props.dumpInfo.exceptionStream.threadContext.rva, 8)}
					</Row>
					<DumpTable
						title="Exception Information"
						headers={["Index", "Value"]}
						rows={exceptionParameterRows}
					/>
				</>
			) : null}

			{hasSection("disassembly") && debugView ? (
				<section class="dump-debugger-panel" aria-label="Disassembly view">
					<h3 class="dump-debugger-panel__title m0">Disassembly</h3>
					<Row label="Status">
						{resolveDisassemblyStatusLabel(debugView.status)} (
						{debugView.message})
					</Row>
					<Row label="Thread">
						{debugView.threadId !== null ? debugView.threadId : "unknown"}
					</Row>
					<Row label="Instruction Pointer">
						{debugView.instructionPointer !== null
							? fmtHex(debugView.instructionPointer, 16)
							: "unknown"}
					</Row>
					<Row label="Exception Address">
						{debugView.exceptionAddress !== null
							? fmtHex(debugView.exceptionAddress, 16)
							: "unknown"}
					</Row>
					<Row label="Exception Code">
						{debugView.exceptionCode !== null
							? fmtHex(debugView.exceptionCode, 8)
							: "unknown"}
					</Row>

					{debugView.registers ? (
						<div class="dump-info-panel__table-wrap">
							<p class="dump-info-panel__table-title text-medium">
								Registers (x64)
							</p>
							<table class="dump-info-table">
								<thead>
									<tr>
										<th>RIP</th>
										<th>RSP</th>
										<th>RBP</th>
										<th>RAX</th>
										<th>RBX</th>
										<th>RCX</th>
										<th>RDX</th>
										<th>RSI</th>
										<th>RDI</th>
										<th>R8</th>
										<th>R9</th>
										<th>R10</th>
										<th>R11</th>
										<th>R12</th>
										<th>R13</th>
										<th>R14</th>
										<th>R15</th>
										<th>RFLAGS</th>
									</tr>
								</thead>
								<tbody>
									<tr>
										<td>
											<code>{fmtHex(debugView.registers.rip, 16)}</code>
										</td>
										<td>
											<code>{fmtHex(debugView.registers.rsp, 16)}</code>
										</td>
										<td>
											<code>{fmtHex(debugView.registers.rbp, 16)}</code>
										</td>
										<td>
											<code>{fmtHex(debugView.registers.rax, 16)}</code>
										</td>
										<td>
											<code>{fmtHex(debugView.registers.rbx, 16)}</code>
										</td>
										<td>
											<code>{fmtHex(debugView.registers.rcx, 16)}</code>
										</td>
										<td>
											<code>{fmtHex(debugView.registers.rdx, 16)}</code>
										</td>
										<td>
											<code>{fmtHex(debugView.registers.rsi, 16)}</code>
										</td>
										<td>
											<code>{fmtHex(debugView.registers.rdi, 16)}</code>
										</td>
										<td>
											<code>{fmtHex(debugView.registers.r8, 16)}</code>
										</td>
										<td>
											<code>{fmtHex(debugView.registers.r9, 16)}</code>
										</td>
										<td>
											<code>{fmtHex(debugView.registers.r10, 16)}</code>
										</td>
										<td>
											<code>{fmtHex(debugView.registers.r11, 16)}</code>
										</td>
										<td>
											<code>{fmtHex(debugView.registers.r12, 16)}</code>
										</td>
										<td>
											<code>{fmtHex(debugView.registers.r13, 16)}</code>
										</td>
										<td>
											<code>{fmtHex(debugView.registers.r14, 16)}</code>
										</td>
										<td>
											<code>{fmtHex(debugView.registers.r15, 16)}</code>
										</td>
										<td>
											<code>{fmtHex(debugView.registers.rflags, 8)}</code>
										</td>
									</tr>
								</tbody>
							</table>
						</div>
					) : null}

					<div class="dump-info-panel__table-wrap">
						<p class="dump-info-panel__table-title text-medium">
							Instruction Listing (surrounding)
						</p>
						<table class="dump-info-table dump-disassembly-table">
							<thead>
								<tr>
									<th>Addr</th>
									<th>Bytes</th>
									<th>Instruction</th>
								</tr>
							</thead>
							<tbody>
								{debugView.lines.length > 0 ? (
									<For each={debugView.lines}>
										{(line) => (
											<tr
												class={
													line.isCurrent
														? "dump-disassembly-table__current"
														: ""
												}
											>
												<td>
													<code>{fmtHex(line.address, 16)}</code>
												</td>
												<td>
													<code>{line.bytesHex}</code>
												</td>
												<td>
													<code>
														{line.mnemonic}
														{line.operands ? ` ${line.operands}` : ""}
													</code>
												</td>
											</tr>
										)}
									</For>
								) : (
									<tr>
										<td colSpan={4}>
											<code>none</code>
										</td>
									</tr>
								)}
							</tbody>
						</table>
					</div>
				</section>
			) : null}

			{hasSection("modules") && props.dumpInfo.moduleList ? (
				<>
					<Row label="Modules">{props.dumpInfo.moduleList.length}</Row>
					<DumpTable
						title="Module Entries"
						headers={[
							"Base",
							"Size",
							"Checksum",
							"TimeDateStamp",
							"Name",
							"CV Size",
							"CV Format",
							"CV PDB",
							"CV Identifier",
							"CV Age",
							"Misc Size",
							"Misc RVA",
						]}
						rows={moduleRows}
					/>
				</>
			) : null}

			{hasSection("modules") && props.dumpInfo.unloadedModuleList ? (
				<>
					<Row label="Unloaded Modules">
						{props.dumpInfo.unloadedModuleList.length}
					</Row>
					<DumpTable
						title="Unloaded Module Entries"
						headers={["Base", "Size", "Checksum", "TimeDateStamp", "Name"]}
						rows={unloadedModuleRows}
					/>
				</>
			) : null}

			{hasSection("memory") && props.dumpInfo.memoryRanges ? (
				<>
					<Row label="Memory Ranges">
						{memoryListSummary ? memoryListSummary.rangeCount : 0}
					</Row>
					<Row label="Memory Bytes">
						{memoryListSummary
							? formatBytes(memoryListSummary.totalBytes)
							: "0 B"}
					</Row>
					{memoryListSummary ? (
						<Row label="Memory Address Span">
							{fmtHex(memoryListSummary.startAddress, 16)} to{" "}
							{fmtHex(memoryListSummary.endAddressExclusive, 16)} (end
							exclusive)
						</Row>
					) : null}
				</>
			) : null}

			{hasSection("threads") && props.dumpInfo.associatedThreads ? (
				<>
					<Row label="Threads (Merged)">{mergedThreadCount}</Row>
					<DumpTable
						title="Merged Thread Entries"
						headers={[
							"Thread ID",
							"Suspended",
							"Priority",
							"TEB",
							"Stack Start",
							"Stack Size",
							"Stack RVA",
							"Context Size",
							"Context RVA",
							"Dump Flags",
							"Dump Error",
							"Exit Status",
							"Create Time",
							"Exit Time",
							"Kernel Time",
							"User Time",
							"Start Address",
							"Affinity",
						]}
						rows={associatedRows}
					/>
				</>
			) : null}
		</section>
	);
}
