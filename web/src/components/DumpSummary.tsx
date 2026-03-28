import { For, type ParentComponent, Show } from "solid-js";
import type { ParsedDumpInfo } from "../lib/dumpInfo";
import type { DumpSection } from "../lib/dumpSections";
import {
	fmtHex,
	fmtHex8,
	fmtHex16,
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
	type MinidumpModule,
	type MinidumpUnloadedModule,
} from "../lib/minidump";

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

const RawRow: ParentComponent<Record<string, never>> = (props) => (
	<p class="dump-info-panel__item">
		<code>{props.children}</code>
	</p>
);

const formatTimestamp = (timestamp: number) => {
	if (!timestamp) {
		return "0 (unset)";
	}

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
	const ranges = memoryRanges.map((range) => ({
		start: range.address,
		size: range.dataSize,
	}));

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
	title?: string;
	headers: string[];
	rows: string[][];
};

const DumpTable = (props: DumpTableProps) => (
	<div class="dump-info-panel__table-wrap">
		<Show when={props.title}>
			<p class="dump-info-panel__table-title text-medium">{props.title}</p>
		</Show>
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
	(associatedThreads ?? []).map((thread) => [
		String(thread.threadId),
		thread.suspendCount ? String(thread.suspendCount) : emptyCell,
		thread.priorityClass
			? fmtPriority(thread.priorityClass, thread.priority)
			: emptyCell,
		thread.teb ? fmtHex16(thread.teb) : emptyCell,
		thread.stack.startOfMemoryRange
			? fmtHex16(thread.stack.startOfMemoryRange)
			: emptyCell,
		thread.stack.location.dataSize
			? String(thread.stack.location.dataSize)
			: emptyCell,
		thread.stack.location.rva ? fmtHex8(thread.stack.location.rva) : emptyCell,
		thread.threadContext.dataSize
			? String(thread.threadContext.dataSize)
			: emptyCell,
		thread.threadContext.rva ? fmtHex8(thread.threadContext.rva) : emptyCell,
		thread.dumpFlags ? fmtHex8(thread.dumpFlags) : emptyCell,
		thread.dumpError ? fmtHex8(thread.dumpError) : emptyCell,
		thread.exitStatus ? String(thread.exitStatus) : emptyCell,
		thread.createTime ? fmtHex16(thread.createTime) : emptyCell,
		thread.exitTime ? fmtHex16(thread.exitTime) : emptyCell,
		thread.kernelTime ? fmtHex16(thread.kernelTime) : emptyCell,
		thread.userTime ? fmtHex16(thread.userTime) : emptyCell,
		thread.startAddress ? fmtHex16(thread.startAddress) : emptyCell,
		thread.affinity ? fmtHex16(thread.affinity) : emptyCell,
	]);

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

const SummarySection = (props: { dumpInfo: ParsedDumpInfo }) => (
	<>
		<h2 class="dump-info-panel__title m0">Dump Summary</h2>
		<Row label="Checksum">{fmtHex(props.dumpInfo.checksum, 8)}</Row>
		<Row label="Timestamp">{formatTimestamp(props.dumpInfo.timestamp)}</Row>
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
						{fmtHex(props.dumpInfo.systemInfo.cpu.processorFeatures[0], 16)},{" "}
						{fmtHex(props.dumpInfo.systemInfo.cpu.processorFeatures[1], 16)}
					</Row>
				)}
			</div>
		) : null}
		{props.dumpInfo.miscInfo ? (
			<>
				<Row label="MiscInfo Size">{props.dumpInfo.miscInfo.sizeOfInfo}</Row>
				<Row label="MiscInfo Flags1">
					{fmtHex(props.dumpInfo.miscInfo.flags1, 8)}
				</Row>
				{props.dumpInfo.miscInfo.processId !== null ? (
					<Row label="Process ID">{props.dumpInfo.miscInfo.processId}</Row>
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
);

const ExceptionSection = (props: {
	dumpInfo: ParsedDumpInfo;
	exceptionParameterRows: string[][];
}) => (
	<>
		<Row label="Exception Thread ID">
			{props.dumpInfo.exceptionStream?.threadId}
		</Row>
		<Row label="Exception Code">
			{fmtHex(
				props.dumpInfo.exceptionStream?.exceptionRecord.exceptionCode ?? 0,
				8,
			)}
		</Row>
		<Row label="Exception Flags">
			{fmtHex(
				props.dumpInfo.exceptionStream?.exceptionRecord.exceptionFlags ?? 0,
				8,
			)}
		</Row>
		<Row label="Exception Address">
			{fmtHex(
				props.dumpInfo.exceptionStream?.exceptionRecord.exceptionAddress ?? 0n,
				16,
			)}
		</Row>
		<Row label="Exception Record">
			{fmtHex(
				props.dumpInfo.exceptionStream?.exceptionRecord.exceptionRecord ?? 0n,
				16,
			)}
		</Row>
		<Row label="Exception Parameters">
			{props.dumpInfo.exceptionStream?.exceptionRecord.numberParameters ?? 0}
		</Row>
		<Row label="Exception Context">
			size={props.dumpInfo.exceptionStream?.threadContext.dataSize ?? 0}, rva=
			{fmtHex(props.dumpInfo.exceptionStream?.threadContext.rva ?? 0, 8)}
		</Row>
		<DumpTable
			headers={["Index", "Value"]}
			rows={props.exceptionParameterRows}
		/>
	</>
);

const ModulesSection = (props: {
	dumpInfo: ParsedDumpInfo;
	moduleRows: string[][];
	unloadedModuleRows: string[][];
}) => (
	<>
		{props.dumpInfo.moduleList ? (
			<DumpTable
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
				rows={props.moduleRows}
			/>
		) : null}
		{props.dumpInfo.unloadedModuleList ? (
			<DumpTable
				headers={["Base", "Size", "Checksum", "TimeDateStamp", "Name"]}
				rows={props.unloadedModuleRows}
			/>
		) : null}
	</>
);

const MemorySection = (props: {
	memoryListSummary: MemoryListSummary | null;
}) => (
	<>
		<Row label="Memory Ranges">
			{props.memoryListSummary ? props.memoryListSummary.rangeCount : 0}
		</Row>
		<Row label="Memory Bytes">
			{props.memoryListSummary
				? formatBytes(props.memoryListSummary.totalBytes)
				: "0 B"}
		</Row>
		{props.memoryListSummary ? (
			<Row label="Memory Address Span">
				{fmtHex(props.memoryListSummary.startAddress, 16)} to{" "}
				{fmtHex(props.memoryListSummary.endAddressExclusive, 16)} (end
				exclusive)
			</Row>
		) : null}
	</>
);

const ThreadsSection = (props: {
	associatedRows: string[][];
	mergedThreadCount: number;
}) => (
	<DumpTable
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
		rows={props.associatedRows}
	/>
);

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
	const hasSection = (section: DumpSection) =>
		props.sections?.includes(section) ?? true;

	return (
		<section class="dump-info-panel" aria-label="Dump details">
			{hasSection("summary") ? (
				<SummarySection dumpInfo={props.dumpInfo} />
			) : null}
			{hasSection("exception") && props.dumpInfo.exceptionStream ? (
				<ExceptionSection
					dumpInfo={props.dumpInfo}
					exceptionParameterRows={exceptionParameterRows}
				/>
			) : null}
			{hasSection("modules") ? (
				<ModulesSection
					dumpInfo={props.dumpInfo}
					moduleRows={moduleRows}
					unloadedModuleRows={unloadedModuleRows}
				/>
			) : null}
			{hasSection("memory") ? (
				<MemorySection memoryListSummary={memoryListSummary} />
			) : null}
			{hasSection("threads") && props.dumpInfo.associatedThreads ? (
				<ThreadsSection
					associatedRows={associatedRows}
					mergedThreadCount={mergedThreadCount}
				/>
			) : null}
		</section>
	);
}
