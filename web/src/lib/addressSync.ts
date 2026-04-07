import { Signal } from "./reactive";

export type AddressNavEvent = {
	address: bigint;
	sourceId: string;
};

export const addressNavSignal = new Signal<AddressNavEvent | null>(null);
export const addressSelectSignal = new Signal<AddressNavEvent | null>(null);
