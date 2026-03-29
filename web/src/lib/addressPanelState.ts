export type AddressPanelSavedState = {
	manualAddressHex?: string;
	followInstructionPointer?: boolean;
};

export const parseHexAddress = (value: string): bigint | null => {
	const trimmed = value.trim();
	if (!trimmed) {
		return null;
	}

	const normalized =
		trimmed.startsWith("0x") || trimmed.startsWith("0X")
			? trimmed.slice(2)
			: trimmed;
	if (!/^[0-9a-fA-F]+$/.test(normalized)) {
		return null;
	}

	try {
		return BigInt(`0x${normalized}`);
	} catch {
		return null;
	}
};

export const loadAddressPanelState = (
	storageKey: string,
): AddressPanelSavedState => {
	try {
		const raw = window.localStorage.getItem(storageKey);
		if (!raw) {
			return {};
		}

		const parsed = JSON.parse(raw) as AddressPanelSavedState;
		return {
			manualAddressHex:
				typeof parsed.manualAddressHex === "string"
					? parsed.manualAddressHex
					: undefined,
			followInstructionPointer:
				typeof parsed.followInstructionPointer === "boolean"
					? parsed.followInstructionPointer
					: undefined,
		};
	} catch {
		return {};
	}
};

export const saveAddressPanelState = (
	storageKey: string,
	state: AddressPanelSavedState,
): void => {
	try {
		window.localStorage.setItem(storageKey, JSON.stringify(state));
	} catch {
		// Ignore storage failures so panel interactions continue to work.
	}
};
