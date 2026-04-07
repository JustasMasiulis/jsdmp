const MAX_ENTRIES = 64;

export class AddressHistory {
	private stack: bigint[] = [];
	private cursor = -1;

	push(address: bigint): void {
		if (this.cursor >= 0 && this.stack[this.cursor] === address) {
			return;
		}

		this.stack.length = this.cursor + 1;
		this.stack.push(address);

		if (this.stack.length > MAX_ENTRIES) {
			this.stack.shift();
		} else {
			this.cursor++;
		}
	}

	canGoBack(): boolean {
		return this.cursor > 0;
	}

	canGoForward(): boolean {
		return this.cursor < this.stack.length - 1;
	}

	goBack(): bigint | null {
		if (!this.canGoBack()) return null;
		return this.stack[--this.cursor];
	}

	goForward(): bigint | null {
		if (!this.canGoForward()) return null;
		return this.stack[++this.cursor];
	}

	current(): bigint | null {
		return this.cursor >= 0 ? this.stack[this.cursor] : null;
	}

	clear(): void {
		this.stack.length = 0;
		this.cursor = -1;
	}
}
