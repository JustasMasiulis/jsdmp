import { For, type ParentComponent, Show } from "solid-js";
import type { ParsedDumpInfo } from "../lib/dumpInfo";
import type { DumpSection } from "../lib/dumpSections";
import {
	type DebugCodeViewInfo,
	type DebugMemoryRange,
	type DebugModule,
	type DebugThread,
	type DebugUnloadedModule,
} from "../lib/debug_interface";
import {
	getMinidumpStreamTypeName,
	type MinidumpDebugExceptionInfo,
} from "../lib/minidump_debug_interface";
import {
	fmtHex,
	fmtHex8,
	fmtHex16,
	fmtOs,
	fmtPriority,
	fmtProductAndSuite,
} from "../lib/formatting";

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

const formatBytes = (value: bigint) => `${value.toString()} B`;

type MemoryListSummary = {
	rangeCount: number;
	totalBytes: bigint;
	startAddress: bigint;
	endAddressExclusive: bigint;
};

const summarizeMemoryList = (
	memoryRanges: DebugMemoryRange[],
): MemoryListSummary | null => {
	const ranges = memoryRanges.map((range) => ({
		start: range.address,
		size: range.size,
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
	threads: DebugThread[],
): string[][] =>
	threads.map((thread) => [
		String(thread.id),
		thread.suspendCount ? String(thread.suspendCount) : emptyCell,
		thread.priorityClass
			? fmtPriority(thread.priorityClass, thread.priority)
			: emptyCell,
		thread.teb ? fmtHex16(thread.teb) : emptyCell,
		thread.stack.address ? fmtHex16(thread.stack.address) : emptyCell,
		thread.stack.location.size
			? String(thread.stack.location.size)
			: emptyCell,
		thread.stack.location.rva ? fmtHex8(thread.stack.location.rva) : emptyCell,
		thread.contextLocation.size ? String(thread.contextLocation.size) : emptyCell,
		thread.contextLocation.rva
			? fmtHex8(thread.contextLocation.rva)
			: emptyCell,
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
	exceptionInfo: MinidumpDebugExceptionInfo | null,
): string[][] =>
	(exceptionInfo?.exceptionRecord.exceptionInformation ?? []).map(
		(value, index) => [String(index), fmtHex(value, 16)],
	);

const buildCodeViewColumns = (
	codeViewInfo: DebugCodeViewInfo | null,
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

const buildModuleRows = (moduleList: DebugModule[]): string[][] =>
	moduleList.map((module) => {
		const [cvFormat, cvPdb, cvIdentifier, cvAge] = buildCodeViewColumns(
			module.codeViewInfo,
		);

		return [
			fmtHex(module.address, 16),
			fmtHex(module.size, 8),
			fmtHex(module.checksum, 8),
			fmtHex(module.timeDateStamp, 8),
			module.path || emptyCell,
			fmtHex(module.codeViewRecord.size, 8),
			cvFormat,
			cvPdb,
			cvIdentifier,
			cvAge,
			fmtHex(module.miscRecord.size, 8),
			fmtHex(module.miscRecord.rva, 8),
		];
	});

const buildUnloadedModuleRows = (
	unloadedModuleList: DebugUnloadedModule[],
): string[][] =>
	unloadedModuleList.map((module) => [
		fmtHex(module.address, 16),
		fmtHex(module.size, 8),
		fmtHex(module.checksum, 8),
		fmtHex(module.timeDateStamp, 8),
		module.path || emptyCell,
	]);

const SummarySection = (props: { dumpInfo: ParsedDumpInfo }) => (
	<>
		{(() => {
			const debugInterface = props.dumpInfo.debugInterface;
			return (
				<>
		<h2 class="dump-info-panel__title m0">Dump Summary</h2>
		<Row label="Checksum">{fmtHex(debugInterface.checksum, 8)}</Row>
		<Row label="Timestamp">{formatTimestamp(debugInterface.timestamp)}</Row>
		<Row label="Flags">{fmtHex(debugInterface.flags, 16)}</Row>
		<Row label="Streams">{debugInterface.streamCount}</Row>
		<Row label="Stream Types">
			{debugInterface.streamTypes.length > 0
				? debugInterface.streamTypes.map(getMinidumpStreamTypeName).join(", ")
				: "none"}
		</Row>
		{debugInterface.systemInfo ? (
			<div class="dump-info-panel__table-wrap">
				<RawRow>{fmtOs(debugInterface.systemInfo)}</RawRow>
				<RawRow>{fmtProductAndSuite(debugInterface.systemInfo)}</RawRow>
				<Row label="CPU Revision">
					level {debugInterface.systemInfo.processorLevel}, rev{" "}
					{fmtHex(debugInterface.systemInfo.processorRevision, 4)}
				</Row>
				{debugInterface.systemInfo.cpu.type === "x86" ? (
					<Row label="CPU Vendor">
						{debugInterface.systemInfo.cpu.vendorId || "unknown"}
					</Row>
				) : (
					<Row label="CPU Features">
						{fmtHex(debugInterface.systemInfo.cpu.processorFeatures[0], 16)},{" "}
						{fmtHex(debugInterface.systemInfo.cpu.processorFeatures[1], 16)}
					</Row>
				)}
			</div>
		) : null}
		{debugInterface.miscInfo ? (
			<>
				<Row label="MiscInfo Size">{debugInterface.miscInfo.sizeOfInfo}</Row>
				<Row label="MiscInfo Flags1">
					{fmtHex(debugInterface.miscInfo.flags1, 8)}
				</Row>
				{debugInterface.miscInfo.processId !== null ? (
					<Row label="Process ID">{debugInterface.miscInfo.processId}</Row>
				) : null}
				{debugInterface.miscInfo.processCreateTime !== null ? (
					<Row label="Process Create Time">
						{formatTimestamp(debugInterface.miscInfo.processCreateTime)}
					</Row>
				) : null}
				{debugInterface.miscInfo.processUserTime !== null ? (
					<Row label="Process User Time">
						{formatSeconds(debugInterface.miscInfo.processUserTime)}
					</Row>
				) : null}
				{debugInterface.miscInfo.processKernelTime !== null ? (
					<Row label="Process Kernel Time">
						{formatSeconds(debugInterface.miscInfo.processKernelTime)}
					</Row>
				) : null}
				{debugInterface.miscInfo.processorMaxMhz !== null ? (
					<Row label="CPU Max MHz">
						{debugInterface.miscInfo.processorMaxMhz}
					</Row>
				) : null}
				{debugInterface.miscInfo.processorCurrentMhz !== null ? (
					<Row label="CPU Current MHz">
						{debugInterface.miscInfo.processorCurrentMhz}
					</Row>
				) : null}
				{debugInterface.miscInfo.processorMhzLimit !== null ? (
					<Row label="CPU MHz Limit">
						{debugInterface.miscInfo.processorMhzLimit}
					</Row>
				) : null}
				{debugInterface.miscInfo.processorMaxIdleState !== null ? (
					<Row label="CPU Max Idle State">
						{debugInterface.miscInfo.processorMaxIdleState}
					</Row>
				) : null}
				{debugInterface.miscInfo.processorCurrentIdleState !== null ? (
					<Row label="CPU Current Idle State">
						{debugInterface.miscInfo.processorCurrentIdleState}
					</Row>
				) : null}
			</>
		) : null}
				</>
			);
		})()}
	</>
);

const ExceptionSection = (props: {
	dumpInfo: ParsedDumpInfo;
	exceptionParameterRows: string[][];
}) => (
	<>
		<Row label="Exception Thread ID">
			{props.dumpInfo.debugInterface.exceptionInfo?.threadId}
		</Row>
		<Row label="Exception Code">
			{fmtHex(
				props.dumpInfo.debugInterface.exceptionInfo?.exceptionRecord.exceptionCode ??
					0,
				8,
			)}
		</Row>
		<Row label="Exception Flags">
			{fmtHex(
				props.dumpInfo.debugInterface.exceptionInfo?.exceptionRecord
					.exceptionFlags ?? 0,
				8,
			)}
		</Row>
		<Row label="Exception Address">
			{fmtHex(
				props.dumpInfo.debugInterface.exceptionInfo?.exceptionRecord
					.exceptionAddress ?? 0n,
				16,
			)}
		</Row>
		<Row label="Exception Record">
			{fmtHex(
				props.dumpInfo.debugInterface.exceptionInfo?.exceptionRecord
					.exceptionRecord ?? 0n,
				16,
			)}
		</Row>
		<Row label="Exception Parameters">
			{props.dumpInfo.debugInterface.exceptionInfo?.exceptionRecord
				.numberParameters ?? 0}
		</Row>
		<Row label="Exception Context">
			size={props.dumpInfo.debugInterface.exceptionInfo?.contextLocation.size ?? 0},
			rva=
			{fmtHex(
				props.dumpInfo.debugInterface.exceptionInfo?.contextLocation.rva ?? 0,
				8,
			)}
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
		{props.dumpInfo.debugInterface.dm.modules.length > 0 ? (
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
		{props.dumpInfo.debugInterface.dm.unloadedModules.length > 0 ? (
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
	const associatedRows = buildAssociatedRows(props.dumpInfo.debugInterface.dm.threads);
	const exceptionParameterRows = buildExceptionParameterRows(
		props.dumpInfo.debugInterface.exceptionInfo,
	);
	const moduleRows = buildModuleRows(props.dumpInfo.debugInterface.dm.modules);
	const unloadedModuleRows = buildUnloadedModuleRows(
		props.dumpInfo.debugInterface.dm.unloadedModules,
	);
	const memoryListSummary = summarizeMemoryList(
		props.dumpInfo.debugInterface.dm.memoryRanges ?? [],
	);
	const mergedThreadCount = associatedRows.length;
	const hasSection = (section: DumpSection) =>
		props.sections?.includes(section) ?? true;

	return (
		<section class="dump-info-panel" aria-label="Dump details">
			{hasSection("summary") ? (
				<SummarySection dumpInfo={props.dumpInfo} />
			) : null}
			{hasSection("exception") && props.dumpInfo.debugInterface.exceptionInfo ? (
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
			{hasSection("threads") &&
			props.dumpInfo.debugInterface.dm.threads.length > 0 ? (
				<ThreadsSection
					associatedRows={associatedRows}
					mergedThreadCount={mergedThreadCount}
				/>
			) : null}
		</section>
	);
}
