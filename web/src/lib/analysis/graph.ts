const BITS_PER_WORD = 32;

export class BitSet {
	private _words: Uint32Array;
	private _size: number;

	constructor(size: number) {
		this._size = size;
		this._words = new Uint32Array((size + BITS_PER_WORD - 1) >>> 5);
	}

	has(index: number): boolean {
		return (this._words[index >>> 5] & (1 << (index & 31))) !== 0;
	}

	set(index: number): void {
		this._words[index >>> 5] |= 1 << (index & 31);
	}

	clear(index: number): void {
		this._words[index >>> 5] &= ~(1 << (index & 31));
	}

	toggle(index: number): void {
		this._words[index >>> 5] ^= 1 << (index & 31);
	}

	forEach(callback: (index: number) => void): void {
		for (let w = 0; w < this._words.length; w++) {
			let bits = this._words[w];
			while (bits !== 0) {
				const lsb = bits & -bits;
				const bit = 31 - Math.clz32(lsb);
				callback((w << 5) | bit);
				bits ^= lsb;
			}
		}
	}

	count(): number {
		let total = 0;
		for (let w = 0; w < this._words.length; w++) {
			let v = this._words[w];
			v = v - ((v >>> 1) & 0x55555555);
			v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
			total += (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
		}
		return total;
	}

	clone(): BitSet {
		const bs = new BitSet(this._size);
		bs._words.set(this._words);
		return bs;
	}

	reset(): void {
		this._words.fill(0);
	}
}

export interface ReadonlyGraph {
	readonly nodeCount: number;
	successors(node: number): ArrayLike<number>;
	predecessors(node: number): ArrayLike<number>;
}

export const UNDEFINED = 0xffffffff;

export class NodeAttr<T> {
	private _data: T[];

	constructor(size: number, defaultValue: T) {
		this._data = new Array<T>(size).fill(defaultValue);
	}

	get(node: number): T {
		return this._data[node];
	}

	set(node: number, value: T): void {
		this._data[node] = value;
	}

	fill(value: T): void {
		this._data.fill(value);
	}

	resize(newSize: number, defaultValue: T): void {
		const old = this._data.length;
		this._data.length = newSize;
		for (let i = old; i < newSize; i++) this._data[i] = defaultValue;
	}
}

export { NodeAttr as EdgeAttr };

export class DiGraph implements ReadonlyGraph {
	readonly nodeCount: number;
	readonly edgeCount: number;

	private readonly _succOffsets: Uint32Array;
	private readonly _succArray: Uint32Array;
	private readonly _succEdgeIds: Uint32Array;

	private readonly _predOffsets: Uint32Array;
	private readonly _predArray: Uint32Array;
	private readonly _predEdgeIds: Uint32Array;

	private readonly _edgeSrc: Uint32Array;
	private readonly _edgeDst: Uint32Array;

	constructor(
		nodeCount: number,
		edgeCount: number,
		succOffsets: Uint32Array,
		succArray: Uint32Array,
		succEdgeIds: Uint32Array,
		predOffsets: Uint32Array,
		predArray: Uint32Array,
		predEdgeIds: Uint32Array,
		edgeSrc: Uint32Array,
		edgeDst: Uint32Array,
	) {
		this.nodeCount = nodeCount;
		this.edgeCount = edgeCount;
		this._succOffsets = succOffsets;
		this._succArray = succArray;
		this._succEdgeIds = succEdgeIds;
		this._predOffsets = predOffsets;
		this._predArray = predArray;
		this._predEdgeIds = predEdgeIds;
		this._edgeSrc = edgeSrc;
		this._edgeDst = edgeDst;
	}

	successors(node: number): Uint32Array {
		return this._succArray.subarray(
			this._succOffsets[node],
			this._succOffsets[node + 1],
		);
	}

	predecessors(node: number): Uint32Array {
		return this._predArray.subarray(
			this._predOffsets[node],
			this._predOffsets[node + 1],
		);
	}

	outDegree(node: number): number {
		return this._succOffsets[node + 1] - this._succOffsets[node];
	}

	predecessorEdgeIds(node: number): Uint32Array {
		return this._predEdgeIds.subarray(
			this._predOffsets[node],
			this._predOffsets[node + 1],
		);
	}

	inDegree(node: number): number {
		return this._predOffsets[node + 1] - this._predOffsets[node];
	}

	edgeSrc(edge: number): number {
		return this._edgeSrc[edge];
	}

	edgeDst(edge: number): number {
		return this._edgeDst[edge];
	}

	edgeIndex(src: number, dst: number): number {
		const begin = this._succOffsets[src];
		const end = this._succOffsets[src + 1];
		for (let i = begin; i < end; i++) {
			if (this._succArray[i] === dst) return this._succEdgeIds[i];
		}
		return -1;
	}
}

export class DiGraphBuilder {
	private _nodeCount = 0;
	private _edgeSrc: number[] = [];
	private _edgeDst: number[] = [];

	addNode(): number {
		return this._nodeCount++;
	}

	addEdge(src: number, dst: number): number {
		const idx = this._edgeSrc.length;
		this._edgeSrc.push(src);
		this._edgeDst.push(dst);
		return idx;
	}

	build(): DiGraph {
		const nodeCount = this._nodeCount;
		const edgeCount = this._edgeSrc.length;

		const edgeSrc = new Uint32Array(this._edgeSrc);
		const edgeDst = new Uint32Array(this._edgeDst);

		const succOffsets = new Uint32Array(nodeCount + 1);
		const predOffsets = new Uint32Array(nodeCount + 1);

		for (let e = 0; e < edgeCount; e++) {
			succOffsets[edgeSrc[e] + 1]++;
			predOffsets[edgeDst[e] + 1]++;
		}
		for (let n = 1; n <= nodeCount; n++) {
			succOffsets[n] += succOffsets[n - 1];
			predOffsets[n] += predOffsets[n - 1];
		}

		const succArray = new Uint32Array(edgeCount);
		const succEdgeIds = new Uint32Array(edgeCount);
		const predArray = new Uint32Array(edgeCount);
		const predEdgeIds = new Uint32Array(edgeCount);

		const succPos = new Uint32Array(nodeCount);
		const predPos = new Uint32Array(nodeCount);
		succPos.set(succOffsets.subarray(0, nodeCount));
		predPos.set(predOffsets.subarray(0, nodeCount));

		for (let e = 0; e < edgeCount; e++) {
			const s = edgeSrc[e];
			const d = edgeDst[e];

			const si = succPos[s];
			succArray[si] = d;
			succEdgeIds[si] = e;
			succPos[s] = si + 1;

			const pi = predPos[d];
			predArray[pi] = s;
			predEdgeIds[pi] = e;
			predPos[d] = pi + 1;
		}

		return new DiGraph(
			nodeCount,
			edgeCount,
			succOffsets,
			succArray,
			succEdgeIds,
			predOffsets,
			predArray,
			predEdgeIds,
			edgeSrc,
			edgeDst,
		);
	}
}

export class MutableGraph implements ReadonlyGraph {
	private _succs: number[][] = [];
	private _preds: number[][] = [];

	constructor(nodeCount = 0) {
		for (let i = 0; i < nodeCount; i++) {
			this._succs.push([]);
			this._preds.push([]);
		}
	}

	get nodeCount(): number {
		return this._succs.length;
	}

	addNode(): number {
		const idx = this._succs.length;
		this._succs.push([]);
		this._preds.push([]);
		return idx;
	}

	addEdge(src: number, dst: number): void {
		this._succs[src]?.push(dst);
		this._preds[dst]?.push(src);
	}

	removeEdge(src: number, dst: number): boolean {
		const succs = this._succs[src];
		const si = succs.indexOf(dst);
		if (si === -1) return false;
		succs.splice(si, 1);

		const preds = this._preds[dst];
		const pi = preds.indexOf(src);
		if (pi !== -1) preds.splice(pi, 1);

		return true;
	}

	reverseEdge(src: number, dst: number): void {
		this.removeEdge(src, dst);
		this.addEdge(dst, src);
	}

	successors(node: number): readonly number[] {
		return this._succs[node];
	}

	predecessors(node: number): readonly number[] {
		return this._preds[node];
	}

	outDegree(node: number): number {
		return this._succs[node]?.length;
	}

	inDegree(node: number): number {
		return this._preds[node]?.length;
	}

	static fromEdges(
		nodeCount: number,
		edges: ArrayLike<[number, number]>,
	): MutableGraph {
		const g = new MutableGraph(nodeCount);
		for (let i = 0; i < edges.length; i++) {
			g.addEdge(edges[i][0], edges[i][1]);
		}
		return g;
	}

	static fromDiGraph(g: DiGraph): MutableGraph {
		const mg = new MutableGraph(g.nodeCount);
		for (let e = 0; e < g.edgeCount; e++) {
			mg.addEdge(g.edgeSrc(e), g.edgeDst(e));
		}
		return mg;
	}
}

export class SubGraph implements ReadonlyGraph {
	readonly nodeCount: number;
	private readonly _localToGlobal: Uint32Array;
	private readonly _globalToLocal: Int32Array;
	private readonly _graph: MutableGraph;

	constructor(parent: DiGraph, nodes: number[]) {
		this.nodeCount = nodes.length;
		this._localToGlobal = new Uint32Array(nodes);

		const maxNode = parent.nodeCount;
		this._globalToLocal = new Int32Array(maxNode).fill(-1);
		for (let i = 0; i < nodes.length; i++) {
			this._globalToLocal[nodes[i]] = i;
		}

		this._graph = new MutableGraph(nodes.length);

		for (let i = 0; i < nodes.length; i++) {
			const globalNode = nodes[i];
			const succs = parent.successors(globalNode);
			for (let j = 0; j < succs.length; j++) {
				const localDst = this._globalToLocal[succs[j]];
				if (localDst !== -1) {
					this._graph.addEdge(i, localDst);
				}
			}
		}
	}

	localToGlobal(local: number): number {
		return this._localToGlobal[local];
	}

	globalToLocal(global: number): number {
		if (global < 0 || global >= this._globalToLocal.length) return -1;
		return this._globalToLocal[global];
	}

	successors(local: number): readonly number[] {
		return this._graph.successors(local);
	}

	predecessors(local: number): readonly number[] {
		return this._graph.predecessors(local);
	}

	toMutableGraph(): MutableGraph {
		return this._graph;
	}
}
