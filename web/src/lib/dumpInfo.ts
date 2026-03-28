export const ALLOWED_DUMP_EXTENSIONS = [".dmp", ".mdmp", ".dump"] as const;

export const formatDumpFileSize = (bytes: number): string => {
	if (bytes < 1024) {
		return `${bytes} B`;
	}
	if (bytes < 1024 * 1024) {
		return `${(bytes / 1024).toFixed(1)} KB`;
	}
	if (bytes < 1024 * 1024 * 1024) {
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	}
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
};

export const isSupportedDumpFile = (file: Pick<File, "name">): boolean => {
	const lowerName = file.name.toLowerCase();
	return ALLOWED_DUMP_EXTENSIONS.some((extension) =>
		lowerName.endsWith(extension),
	);
};
