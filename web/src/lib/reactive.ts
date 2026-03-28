type SignalListener<_T> = () => void;

export class Signal<T> {
	private listeners: SignalHandle<T>[] = [];
	state: T;

	subscribe(listener: SignalListener<T>): SignalHandle<T> {
		const handle = new SignalHandle(this, listener);
		this.listeners.push(handle);
		return handle;
	}

	unsubscribe(handle: SignalHandle<T>): void {
		this.listeners = this.listeners.filter((l) => l !== handle);
	}

	set(value: T): void {
		this.state = value;
		this.listeners.forEach((handle) => {
			handle.invoke();
		});
	}
}

class SignalHandle<T> {
	private _signal: Signal<T>;
	private _callback: SignalListener<T>;
	private _pending: boolean = false;
	private _enabled: boolean = true;

	constructor(signal: Signal<T>, callback: SignalListener<T>) {
		this._signal = signal;
		this._callback = callback;
	}

	enable(): void {
		this._enabled = true;
		if (this._pending) {
			this._pending = false;
			this._callback();
		}
	}

	disable(): void {
		this._enabled = false;
	}

	toggle(): void {
		this._enabled = !this._enabled;
		if (this._enabled && this._pending) {
			this._pending = false;
			this._callback();
		}
	}

	dispose(): void {
		this._signal.unsubscribe(this);
	}

	invoke(): void {
		if (this._enabled) {
			this._callback();
		} else {
			this._pending = true;
		}
	}
}
