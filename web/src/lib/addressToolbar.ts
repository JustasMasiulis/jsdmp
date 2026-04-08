import { AddressHistory } from "./addressHistory";
import {
	loadAddressPanelState,
	parseHexAddress,
	saveAddressPanelState,
} from "./addressPanelState";
import type { AddressNavEvent } from "./addressSync";
import { addressNavSignal, addressSelectSignal } from "./addressSync";
import { DBG } from "./debugState";
import { fmtHex16 } from "./formatting";
import type { SignalHandle } from "./reactive";

export type AddressToolbarConfig = {
	panelId: string;
	storageKey: string;
	defaultSync: boolean;
	onNavigate: () => void;
	onFocusAddress?: (address: bigint) => boolean;
	emptyMessage: () => string;
};

export class AddressToolbar {
	readonly errorNode: HTMLParagraphElement;
	readonly emptyNode: HTMLParagraphElement;

	manualAddress: bigint | null = null;
	followInstructionPointer = true;
	syncEnabled: boolean;

	private readonly history = new AddressHistory();
	private readonly config: AddressToolbarConfig;
	private readonly addressInput: HTMLInputElement;
	private readonly jumpButton: HTMLButtonElement;
	private readonly followCheckbox: HTMLInputElement;
	private readonly syncCheckbox: HTMLInputElement;
	private readonly syncHandle: SignalHandle<AddressNavEvent | null>;
	private readonly selectHandle: SignalHandle<AddressNavEvent | null>;
	private isDisposed = false;

	private readonly form: HTMLFormElement;

	constructor(parent: HTMLElement, config: AddressToolbarConfig) {
		this.config = config;
		this.syncEnabled = config.defaultSync;

		const toolbar = document.createElement("div");
		toolbar.className = "memory-view-panel__toolbar";

		const jumpForm = document.createElement("form");
		jumpForm.className = "memory-view-panel__jump";
		this.form = jumpForm;

		const addressInput = document.createElement("input");
		addressInput.id = `address-jump-${config.panelId}`;
		addressInput.className = "memory-view-panel__input";
		addressInput.type = "text";
		addressInput.placeholder = "0x0000000000000000";
		this.addressInput = addressInput;

		const jumpButton = document.createElement("button");
		jumpButton.type = "submit";
		jumpButton.className = "memory-view-panel__button";
		jumpButton.textContent = "Jump";
		this.jumpButton = jumpButton;

		jumpForm.append(addressInput, jumpButton);

		const followLabel = document.createElement("label");
		followLabel.className = "memory-view-panel__toggle";
		const followCheckbox = document.createElement("input");
		followCheckbox.type = "checkbox";
		this.followCheckbox = followCheckbox;
		const followText = document.createElement("span");
		followText.textContent = "Follow IP";
		followLabel.append(followCheckbox, followText);

		const syncLabel = document.createElement("label");
		syncLabel.className = "memory-view-panel__toggle";
		const syncCheckbox = document.createElement("input");
		syncCheckbox.type = "checkbox";
		syncCheckbox.checked = this.syncEnabled;
		this.syncCheckbox = syncCheckbox;
		const syncText = document.createElement("span");
		syncText.textContent = "Sync";
		syncLabel.append(syncCheckbox, syncText);

		toolbar.append(jumpForm, followLabel, syncLabel);

		const errorNode = document.createElement("p");
		errorNode.className = "memory-view-panel__error";
		errorNode.hidden = true;
		this.errorNode = errorNode;

		const emptyNode = document.createElement("p");
		emptyNode.className = "memory-view-panel__empty";
		emptyNode.hidden = true;
		this.emptyNode = emptyNode;

		parent.append(toolbar, errorNode, emptyNode);

		this.form.addEventListener("submit", this.onAddressSubmit);
		this.followCheckbox.addEventListener("change", this.onFollowChange);
		this.syncCheckbox.addEventListener("change", this.onSyncChange);

		this.syncHandle = addressNavSignal.subscribe(() => this.onSyncReceive());
		this.selectHandle = addressSelectSignal.subscribe(() =>
			this.onSelectReceive(),
		);

		this.restoreState();
	}

	currentAnchor(): bigint | null {
		if (this.followInstructionPointer) {
			return DBG.currentContext.state?.ip ?? null;
		}
		return this.manualAddress;
	}

	navigateToAddress(address: bigint): void {
		this.history.push(address);
		this.applyAddress(address, true);
	}

	focusInView(address: bigint): void {
		this.history.push(address);
		this.config.onFocusAddress?.(address);
	}

	selectAddress(address: bigint): void {
		if (!this.syncEnabled) return;
		const prev = addressSelectSignal.state;
		if (prev?.address === address && prev.sourceId === this.config.panelId)
			return;
		addressSelectSignal.set({ address, sourceId: this.config.panelId });
	}

	syncDisplayedAddress(): void {
		const address = this.currentAnchor();
		this.addressInput.value = address !== null ? `0x${fmtHex16(address)}` : "";
	}

	syncControlState(hasContent: boolean): void {
		this.followCheckbox.checked = this.followInstructionPointer;
		this.addressInput.disabled = this.followInstructionPointer;
		this.jumpButton.disabled = this.followInstructionPointer;
		this.errorNode.hidden = this.errorNode.textContent === "";
		this.emptyNode.hidden = hasContent;
		if (!hasContent) {
			this.emptyNode.textContent = this.config.emptyMessage();
		}
	}

	dispose(): void {
		if (this.isDisposed) return;
		this.isDisposed = true;
		this.syncHandle.dispose();
		this.selectHandle.dispose();
		this.form.removeEventListener("submit", this.onAddressSubmit);
		this.followCheckbox.removeEventListener("change", this.onFollowChange);
		this.syncCheckbox.removeEventListener("change", this.onSyncChange);
	}

	readonly onKeyDown = (e: KeyboardEvent): void => {
		if (e.key === "Escape" || (e.altKey && e.key === "ArrowLeft")) {
			e.preventDefault();
			this.navigateBack();
		} else if (e.altKey && e.key === "ArrowRight") {
			e.preventDefault();
			this.navigateForward();
		}
	};

	private applyAddress(address: bigint, publish: boolean): void {
		this.manualAddress = address;
		this.followInstructionPointer = false;
		this.followCheckbox.checked = false;
		this.setAddressError("");
		if (publish) this.publishSync(address);
		this.saveState();
		if (this.config.onFocusAddress?.(address)) return;
		this.config.onNavigate();
	}

	private readonly onAddressSubmit = (event: Event): void => {
		event.preventDefault();
		const parsed = parseHexAddress(this.addressInput.value);
		if (parsed === null) {
			this.setAddressError(
				"Address must be hexadecimal (for example: 0x7FF612340000).",
			);
			return;
		}
		this.navigateToAddress(parsed);
	};

	private readonly onFollowChange = (): void => {
		const next = this.followCheckbox.checked;
		this.followInstructionPointer = next;
		if (!next && this.manualAddress === null) {
			const ip = DBG.currentContext.state?.ip ?? null;
			if (ip !== null) {
				this.manualAddress = ip;
			}
		}
		this.setAddressError("");
		this.saveState();
		this.config.onNavigate();
	};

	private readonly onSyncChange = (): void => {
		this.syncEnabled = this.syncCheckbox.checked;
	};

	private onSyncReceive(): void {
		const ev = addressNavSignal.state;
		if (!ev || ev.sourceId === this.config.panelId || !this.syncEnabled) return;
		this.history.push(ev.address);
		this.applyAddress(ev.address, false);
	}

	private onSelectReceive(): void {
		const ev = addressSelectSignal.state;
		if (!ev || ev.sourceId === this.config.panelId || !this.syncEnabled) return;
		if (this.config.onFocusAddress?.(ev.address)) return;
		this.history.push(ev.address);
		this.applyAddress(ev.address, false);
	}

	private navigateBack(): void {
		const addr = this.history.goBack();
		if (addr === null) return;
		this.applyAddress(addr, true);
	}

	private navigateForward(): void {
		const addr = this.history.goForward();
		if (addr === null) return;
		this.applyAddress(addr, true);
	}

	private publishSync(address: bigint): void {
		if (!this.syncEnabled) return;
		const prev = addressNavSignal.state;
		if (prev?.address === address && prev.sourceId === this.config.panelId)
			return;
		addressNavSignal.set({ address, sourceId: this.config.panelId });
	}

	private setAddressError(message: string): void {
		this.errorNode.hidden = message.length === 0;
		this.errorNode.textContent = message;
	}

	private saveState(): void {
		saveAddressPanelState(this.config.storageKey, {
			manualAddressHex:
				this.manualAddress !== null ? `0x${fmtHex16(this.manualAddress)}` : "",
			followInstructionPointer: this.followInstructionPointer,
		});
	}

	private restoreState(): void {
		const saved = loadAddressPanelState(this.config.storageKey);
		if (typeof saved.followInstructionPointer === "boolean") {
			this.followInstructionPointer = saved.followInstructionPointer;
		}
		if (saved.manualAddressHex) {
			const parsed = parseHexAddress(saved.manualAddressHex);
			if (parsed !== null) {
				this.manualAddress = parsed;
			}
		}
	}
}
