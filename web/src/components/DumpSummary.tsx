import { For, type ParentComponent } from "solid-js";
import {
	MINIDUMP_STREAM_TYPE,
	MiniDumpStreamType,
	priorityToString,
	type MinidumpAssociatedThread,
	type MinidumpExceptionStream,
	type MinidumpMiscInfo,
	type MinidumpSystemInfo,
	type MinidumpThread,
	type MinidumpThreadInfoList,
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
	threadList: MinidumpThread[] | null;
	threadInfoList: MinidumpThreadInfoList | null;
	associatedThreads: MinidumpAssociatedThread[] | null;
};

type DumpSummaryProps = {
	dumpInfo: ParsedDumpInfo;
};

const Row: ParentComponent<{ label: string }> = (props) => (
	<p class="dump-info-panel__item">
		<span class="text-medium">{props.label}:</span> <code>{props.children}</code>
	</p>
);

const toHex = (value: number | bigint, padLength = 0) => {
	const hex = value.toString(16).toUpperCase();
	const padded = padLength > 0 ? hex.padStart(padLength, "0") : hex;
	return `0x${padded}`;
};

const formatTimestamp = (timestamp: number) => {
	if (!timestamp) return "0 (unset)";
	const iso = new Date(timestamp * 1000).toISOString();
	return `${timestamp} (${iso})`;
};

const formatSeconds = (value: number) => `${value} sec`;

const getStreamTypeName = (streamType: number) =>
	MiniDumpStreamType[streamType] ?? `Unknown(${streamType})`;

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
								<For each={row}>{(cell) => <td><code>{cell}</code></td>}</For>
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
			thread ? priorityToString(thread.priorityClass, thread.priority) : emptyCell,
			thread ? toHex(thread.teb, 16) : emptyCell,
			thread ? toHex(thread.stack.startOfMemoryRange, 16) : emptyCell,
			thread ? String(thread.stack.location.dataSize) : emptyCell,
			thread ? toHex(thread.stack.location.rva, 8) : emptyCell,
			thread ? String(thread.threadContext.dataSize) : emptyCell,
			thread ? toHex(thread.threadContext.rva, 8) : emptyCell,
			threadInfo ? toHex(threadInfo.dumpFlags, 8) : emptyCell,
			threadInfo ? toHex(threadInfo.dumpError, 8) : emptyCell,
			threadInfo ? String(threadInfo.exitStatus) : emptyCell,
			threadInfo ? toHex(threadInfo.createTime, 16) : emptyCell,
			threadInfo ? toHex(threadInfo.exitTime, 16) : emptyCell,
			threadInfo ? toHex(threadInfo.kernelTime, 16) : emptyCell,
			threadInfo ? toHex(threadInfo.userTime, 16) : emptyCell,
			threadInfo ? toHex(threadInfo.startAddress, 16) : emptyCell,
			threadInfo ? toHex(threadInfo.affinity, 16) : emptyCell,
		];
	});

const buildExceptionParameterRows = (
	exceptionStream: MinidumpExceptionStream | null,
): string[][] =>
	(exceptionStream?.exceptionRecord.exceptionInformation ?? []).map((value, index) => [
		String(index),
		toHex(value, 16),
	]);

export default function DumpSummary(props: DumpSummaryProps) {
	const associatedRows = buildAssociatedRows(props.dumpInfo.associatedThreads);
	const exceptionParameterRows = buildExceptionParameterRows(props.dumpInfo.exceptionStream);
	const mergedThreadCount = associatedRows.length;

	return (
		<section class="dump-info-panel" aria-label="Dump details">
			<h2 class="dump-info-panel__title m0">Dump Summary</h2>
			<Row label="Checksum">{toHex(props.dumpInfo.checksum, 8)}</Row>
			<Row label="Timestamp">{formatTimestamp(props.dumpInfo.timestamp)}</Row>
			<Row label="Flags">{toHex(props.dumpInfo.flags, 16)}</Row>
			<Row label="Streams">{props.dumpInfo.streamCount}</Row>
			<Row label="Stream Types">
				{props.dumpInfo.streamTypes.length > 0
					? props.dumpInfo.streamTypes.map(getStreamTypeName).join(", ")
					: "none"}
			</Row>

			{props.dumpInfo.systemInfo ? (
				<>
					<Row label="OS">
						{props.dumpInfo.systemInfo.platformName}{" "}
						{props.dumpInfo.systemInfo.majorVersion}.
						{props.dumpInfo.systemInfo.minorVersion} (build{" "}
						{props.dumpInfo.systemInfo.buildNumber})
					</Row>
					<Row label="Service Pack">
						{props.dumpInfo.systemInfo.csdVersion || "none"}
					</Row>
					<Row label="CPU">
						{props.dumpInfo.systemInfo.processorArchitectureName}{" "}
						{props.dumpInfo.systemInfo.numberOfProcessors} processors
					</Row>
					<Row label="Suite Mask">
						{toHex(props.dumpInfo.systemInfo.suiteMask, 4)}
					</Row>
					<Row label="Product Type">{props.dumpInfo.systemInfo.productType}</Row>
					<Row label="CPU Revision">
						level {props.dumpInfo.systemInfo.processorLevel}, rev{" "}
						{toHex(props.dumpInfo.systemInfo.processorRevision, 4)}
					</Row>
					{props.dumpInfo.systemInfo.cpu.type === "x86" ? (
						<Row label="CPU Vendor">
							{props.dumpInfo.systemInfo.cpu.vendorId || "unknown"}
						</Row>
					) : (
						<Row label="CPU Features">
							{toHex(props.dumpInfo.systemInfo.cpu.processorFeatures[0], 16)},{" "}
							{toHex(props.dumpInfo.systemInfo.cpu.processorFeatures[1], 16)}
						</Row>
					)}
				</>
			) : null}

			{props.dumpInfo.miscInfo ? (
				<>
					<Row label="MiscInfo Size">{props.dumpInfo.miscInfo.sizeOfInfo}</Row>
					<Row label="MiscInfo Flags1">
						{toHex(props.dumpInfo.miscInfo.flags1, 8)}
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

			{props.dumpInfo.exceptionStream ? (
				<>
					<Row label="Exception Thread ID">
						{props.dumpInfo.exceptionStream.threadId}
					</Row>
					<Row label="Exception Code">
						{toHex(props.dumpInfo.exceptionStream.exceptionRecord.exceptionCode, 8)}
					</Row>
					<Row label="Exception Flags">
						{toHex(props.dumpInfo.exceptionStream.exceptionRecord.exceptionFlags, 8)}
					</Row>
					<Row label="Exception Address">
						{toHex(props.dumpInfo.exceptionStream.exceptionRecord.exceptionAddress, 16)}
					</Row>
					<Row label="Exception Record">
						{toHex(props.dumpInfo.exceptionStream.exceptionRecord.exceptionRecord, 16)}
					</Row>
					<Row label="Exception Parameters">
						{props.dumpInfo.exceptionStream.exceptionRecord.numberParameters}
					</Row>
					<Row label="Exception Context">
						size={props.dumpInfo.exceptionStream.threadContext.dataSize}, rva=
						{toHex(props.dumpInfo.exceptionStream.threadContext.rva, 8)}
					</Row>
					<DumpTable
						title="Exception Information"
						headers={["Index", "Value"]}
						rows={exceptionParameterRows}
					/>
				</>
			) : null}

			{props.dumpInfo.associatedThreads ? (
				<>
					<Row label="Threads (Merged)">{mergedThreadCount}</Row>
					{props.dumpInfo.threadInfoList ? (
						<Row label="ThreadInfo Header">
							size={props.dumpInfo.threadInfoList.sizeOfHeader}, entry=
							{props.dumpInfo.threadInfoList.sizeOfEntry}
						</Row>
					) : null}
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
