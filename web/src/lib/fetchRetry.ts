const MAX_RETRIES = 3;
const INITIAL_DELAY_MS = 100;
const BACKOFF_FACTOR = 4;
const MAX_CONCURRENT = 50;

let activeFetches = 0;
const waitQueue: (() => void)[] = [];

function acquireSlot(): Promise<void> {
	if (activeFetches < MAX_CONCURRENT) {
		activeFetches++;
		return Promise.resolve();
	}
	return new Promise<void>((resolve) => {
		waitQueue.push(() => {
			activeFetches++;
			resolve();
		});
	});
}

function releaseSlot(): void {
	activeFetches--;
	const next = waitQueue.shift();
	if (next) next();
}

function isRetryable(error: unknown): boolean {
	return error instanceof TypeError;
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchWithRetry(
	input: RequestInfo | URL,
	init?: RequestInit,
): Promise<Response> {
	await acquireSlot();
	try {
		let lastError: unknown;
		for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
			try {
				return await fetch(input, init);
			} catch (error) {
				lastError = error;
				if (attempt < MAX_RETRIES && isRetryable(error)) {
					await delay(INITIAL_DELAY_MS * BACKOFF_FACTOR ** attempt);
					continue;
				}
				throw error;
			}
		}
		throw lastError;
	} finally {
		releaseSlot();
	}
}
