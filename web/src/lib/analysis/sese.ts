import { type ReadonlyGraph, UNDEFINED } from "./graph";
import { buildTreeIntervals, isStrictAncestor } from "./tree-ancestry";

export type SESERegion = {
	entryEdge: number;
	exitEdge: number;
	parent: number;
	children: number[];
	nodes: number[];
};

export type SESEResult = {
	regions: SESERegion[];
	regionOf: Uint32Array;
};

type BracketNode = {
	edgeId: number;
	prev: number;
	next: number;
};

class BracketNodePool {
	private _nodes: BracketNode[];
	private _freeHead: number;

	constructor(capacity: number) {
		this._nodes = new Array(capacity);
		for (let i = 0; i < capacity; i++) {
			this._nodes[i] = { edgeId: 0, prev: UNDEFINED, next: i + 1 };
		}
		if (capacity > 0) {
			this._nodes[capacity - 1].next = UNDEFINED;
		}
		this._freeHead = capacity > 0 ? 0 : UNDEFINED;
	}

	alloc(edgeId: number): number {
		if (this._freeHead === UNDEFINED) {
			const idx = this._nodes.length;
			this._nodes.push({ edgeId, prev: UNDEFINED, next: UNDEFINED });
			return idx;
		}
		const idx = this._freeHead;
		const node = this._nodes[idx];
		this._freeHead = node.next;
		node.edgeId = edgeId;
		node.prev = UNDEFINED;
		node.next = UNDEFINED;
		return idx;
	}

	free(idx: number): void {
		const node = this._nodes[idx];
		node.prev = UNDEFINED;
		node.next = this._freeHead;
		this._freeHead = idx;
	}

	get(idx: number): BracketNode {
		return this._nodes[idx];
	}
}

class BracketList {
	private _pool: BracketNodePool;
	private _head: number;
	private _tail: number;
	private _size: number;

	constructor(pool: BracketNodePool) {
		this._pool = pool;
		this._head = UNDEFINED;
		this._tail = UNDEFINED;
		this._size = 0;
	}

	get size(): number {
		return this._size;
	}

	push(edgeId: number): number {
		const idx = this._pool.alloc(edgeId);
		const node = this._pool.get(idx);
		node.prev = this._tail;
		node.next = UNDEFINED;
		if (this._tail !== UNDEFINED) {
			this._pool.get(this._tail).next = idx;
		} else {
			this._head = idx;
		}
		this._tail = idx;
		this._size++;
		return idx;
	}

	top(): number {
		if (this._tail === UNDEFINED) return -1;
		return this._pool.get(this._tail).edgeId;
	}

	delete(poolIdx: number): void {
		const node = this._pool.get(poolIdx);
		if (node.prev !== UNDEFINED) {
			this._pool.get(node.prev).next = node.next;
		} else {
			this._head = node.next;
		}
		if (node.next !== UNDEFINED) {
			this._pool.get(node.next).prev = node.prev;
		} else {
			this._tail = node.prev;
		}
		this._pool.free(poolIdx);
		this._size--;
	}

	concat(other: BracketList): void {
		if (other._size === 0) return;
		if (this._size === 0) {
			this._head = other._head;
			this._tail = other._tail;
			this._size = other._size;
		} else {
			this._pool.get(this._tail).next = other._head;
			if (other._head !== UNDEFINED) {
				this._pool.get(other._head).prev = this._tail;
			}
			this._tail = other._tail;
			this._size += other._size;
		}
		other._head = UNDEFINED;
		other._tail = UNDEFINED;
		other._size = 0;
	}
}

type DirectedEdge = {
	from: number;
	to: number;
};

type AugmentedGraph = {
	totalNodes: number;
	edges: DirectedEdge[];
	successors: number[][];
	succEdgeIds: number[][];
	allEdges: number[][];
	allEdgeIds: number[][];
};

function buildAugmentedGraph(
	graph: ReadonlyGraph,
	root: number,
): AugmentedGraph {
	const origN = graph.nodeCount;
	const virtualExit = origN;
	const totalNodes = origN + 1;

	const edges: DirectedEdge[] = [];
	const successors: number[][] = new Array(totalNodes);
	const succEdgeIds: number[][] = new Array(totalNodes);
	const allEdges: number[][] = new Array(totalNodes);
	const allEdgeIds: number[][] = new Array(totalNodes);
	for (let i = 0; i < totalNodes; i++) {
		successors[i] = [];
		succEdgeIds[i] = [];
		allEdges[i] = [];
		allEdgeIds[i] = [];
	}

	const addEdge = (from: number, to: number): number => {
		const id = edges.length;
		edges.push({ from, to });
		successors[from].push(to);
		succEdgeIds[from].push(id);
		allEdges[from].push(to);
		allEdgeIds[from].push(id);
		allEdges[to].push(from);
		allEdgeIds[to].push(id);
		return id;
	};

	for (let u = 0; u < origN; u++) {
		const succs = graph.successors(u);
		for (let j = 0; j < succs.length; j++) {
			addEdge(u, succs[j]);
		}
	}

	let hasExitEdge = false;
	for (let u = 0; u < origN; u++) {
		if (graph.successors(u).length === 0) {
			addEdge(u, virtualExit);
			hasExitEdge = true;
		}
	}

	if (hasExitEdge) {
		addEdge(virtualExit, root);
	}

	return { totalNodes, edges, successors, succEdgeIds, allEdges, allEdgeIds };
}

enum UdfsEdgeType {
	NONE = 0,
	TREE = 1,
	BACK = 2,
}

type UdfsResult = {
	dfsOrder: Uint32Array;
	dfsNum: Uint32Array;
	parent: Int32Array;
	parentEdge: Int32Array;
	children: number[][];
	edgeType: Uint8Array;
	nodeCount: number;
};

function unorderedDfs(
	totalNodes: number,
	edgeCount: number,
	allEdges: number[][],
	allEdgeIds: number[][],
	root: number,
): UdfsResult {
	const dfsOrder = new Uint32Array(totalNodes);
	const dfsNum = new Uint32Array(totalNodes).fill(UNDEFINED);
	const parent = new Int32Array(totalNodes).fill(-1);
	const parentEdge = new Int32Array(totalNodes).fill(-1);
	const children: number[][] = new Array(totalNodes);
	const edgeType = new Uint8Array(edgeCount);
	for (let i = 0; i < totalNodes; i++) children[i] = [];

	let orderIdx = 0;

	const stackNode = new Int32Array(totalNodes);
	const stackAdjIdx = new Int32Array(totalNodes);
	let sp = 0;

	dfsNum[root] = orderIdx;
	dfsOrder[orderIdx++] = root;
	stackNode[0] = root;
	stackAdjIdx[0] = 0;
	sp = 1;

	while (sp > 0) {
		const t = sp - 1;
		const node = stackNode[t];
		const ai = stackAdjIdx[t];
		const neighbors = allEdges[node];
		const neighborEdgeIds = allEdgeIds[node];

		if (ai < neighbors.length) {
			stackAdjIdx[t] = ai + 1;
			const neighbor = neighbors[ai];
			const edgeId = neighborEdgeIds[ai];

			if (dfsNum[neighbor] === UNDEFINED) {
				edgeType[edgeId] = UdfsEdgeType.TREE;
				parent[neighbor] = node;
				parentEdge[neighbor] = edgeId;
				children[node].push(neighbor);

				dfsNum[neighbor] = orderIdx;
				dfsOrder[orderIdx++] = neighbor;
				stackNode[sp] = neighbor;
				stackAdjIdx[sp] = 0;
				sp++;
			} else if (edgeType[edgeId] === UdfsEdgeType.NONE) {
				edgeType[edgeId] = UdfsEdgeType.BACK;
			}
		} else {
			sp--;
		}
	}

	return {
		dfsOrder,
		dfsNum,
		parent,
		parentEdge,
		children,
		edgeType,
		nodeCount: orderIdx,
	};
}

function fallbackSingleRegion(nodeCount: number): SESEResult {
	const rootRegion: SESERegion = {
		entryEdge: -1,
		exitEdge: -1,
		parent: -1,
		children: [],
		nodes: [],
	};
	for (let i = 0; i < nodeCount; i++) rootRegion.nodes.push(i);
	return { regions: [rootRegion], regionOf: new Uint32Array(nodeCount) };
}

export function computeSESERegions(
	graph: ReadonlyGraph,
	root: number,
): SESEResult {
	const origN = graph.nodeCount;
	if (origN <= 1) return fallbackSingleRegion(origN);

	const aug = buildAugmentedGraph(graph, root);
	const { totalNodes, edges, allEdges, allEdgeIds, successors, succEdgeIds } =
		aug;
	const edgeCount = edges.length;

	const udfs = unorderedDfs(totalNodes, edgeCount, allEdges, allEdgeIds, root);
	const { dfsOrder, dfsNum, parent, parentEdge, children, edgeType } = udfs;
	const treeIntervals = buildTreeIntervals(children, root);

	const isBackedge = (eid: number): boolean =>
		edgeType[eid] === UdfsEdgeType.BACK;
	const isTreeEdge = (eid: number): boolean =>
		edgeType[eid] === UdfsEdgeType.TREE;

	const succeed = (a: number, b: number): boolean =>
		isStrictAncestor(treeIntervals, a, b);

	const isBackedgeFrom = (eid: number, from: number, to: number): boolean =>
		isBackedge(eid) && succeed(from, to);

	const hi = new Uint32Array(totalNodes).fill(UNDEFINED);

	const getHi0 = (node: number): number => {
		let hi0 = UNDEFINED;
		const neighbors = allEdges[node];
		const neighborEdgeIds = allEdgeIds[node];
		for (let i = 0; i < neighbors.length; i++) {
			const t = neighbors[i];
			const eid = neighborEdgeIds[i];
			if (isBackedgeFrom(eid, node, t)) {
				if (dfsNum[t] < hi0) hi0 = dfsNum[t];
			}
		}
		return hi0;
	};

	const getHi1 = (node: number): number => {
		let hi1 = UNDEFINED;
		for (let i = 0; i < children[node].length; i++) {
			const child = children[node][i];
			if (hi[child] < hi1) hi1 = hi[child];
		}
		return hi1;
	};

	const getHi2 = (node: number, hi1: number): number => {
		let hi2 = UNDEFINED;
		let skippedOne = false;
		for (let i = 0; i < children[node].length; i++) {
			const child = children[node][i];
			const childHi = hi[child];
			if (!skippedOne && childHi === hi1) {
				skippedOne = true;
			} else {
				if (childHi < hi2) hi2 = childHi;
			}
		}
		return hi2;
	};

	const maxEdges = edgeCount + totalNodes;
	const pool = new BracketNodePool(maxEdges * 2);
	const bracketLists: BracketList[] = new Array(totalNodes);
	for (let i = 0; i < totalNodes; i++) {
		bracketLists[i] = new BracketList(pool);
	}

	const edgeClass = new Int32Array(maxEdges);
	const recentSize = new Int32Array(maxEdges);
	const recentClass = new Int32Array(maxEdges);
	const backEdgePoolIdx = new Int32Array(maxEdges).fill(-1);
	let nextClass = 1;

	const cappingBackEdges: number[] = [];
	let totalEdges = edgeCount;

	for (let oi = udfs.nodeCount - 1; oi >= 0; oi--) {
		const node = dfsOrder[oi];
		const hi0 = getHi0(node);
		const hi1 = getHi1(node);
		hi[node] = Math.min(hi0, hi1);
		const hi2 = getHi2(node, hi1);

		const bl = bracketLists[node];

		for (let i = 0; i < children[node].length; i++) {
			bl.concat(bracketLists[children[node][i]]);
		}

		for (let i = 0; i < cappingBackEdges.length; i++) {
			const capEid = cappingBackEdges[i];
			const capEdge = edges[capEid];
			const other =
				capEdge.from === node
					? capEdge.to
					: capEdge.to === node
						? capEdge.from
						: -1;
			if (other !== -1 && succeed(other, node)) {
				const pidx = backEdgePoolIdx[capEid];
				if (pidx !== -1) {
					bl.delete(pidx);
					backEdgePoolIdx[capEid] = -1;
				}
			}
		}

		const neighbors = allEdges[node];
		const neighborEdgeIds = allEdgeIds[node];
		for (let i = 0; i < neighbors.length; i++) {
			const t = neighbors[i];
			const eid = neighborEdgeIds[i];
			if (isBackedgeFrom(eid, t, node)) {
				const pidx = backEdgePoolIdx[eid];
				if (pidx !== -1) {
					bl.delete(pidx);
					backEdgePoolIdx[eid] = -1;
				}
				if (edgeClass[eid] === 0) {
					edgeClass[eid] = nextClass++;
				}
			}
		}

		for (let i = 0; i < neighbors.length; i++) {
			const t = neighbors[i];
			const eid = neighborEdgeIds[i];
			if (isBackedgeFrom(eid, node, t)) {
				backEdgePoolIdx[eid] = bl.push(eid);
			}
		}

		if (hi2 < hi0) {
			const targetNode = dfsOrder[hi2];
			if (targetNode !== undefined) {
				const capEid = totalEdges++;
				edges.push({ from: node, to: targetNode });
				cappingBackEdges.push(capEid);
				backEdgePoolIdx[capEid] = bl.push(capEid);
			}
		}

		if (parent[node] !== -1) {
			const peId = parentEdge[node];
			const topEdge = bl.top();
			if (topEdge >= 0) {
				const topSize = bl.size;
				if (recentSize[topEdge] !== topSize) {
					recentSize[topEdge] = topSize;
					recentClass[topEdge] = nextClass++;
				}
				edgeClass[peId] = recentClass[topEdge];
				if (topSize === 1) {
					edgeClass[topEdge] = edgeClass[peId];
				}
			}
		}
	}

	type NodeClass = {
		nodeId: number;
		edgeId: number;
		edgeClassVal: number;
	};

	const entryEdge = new Uint8Array(totalEdges);
	const exitEdge = new Uint8Array(totalEdges);

	{
		const visited = new Uint8Array(totalNodes);
		const determineRegionBoundaries = (startNode: number) => {
			const sNode = new Int32Array(totalNodes);
			const sSuccIdx = new Int32Array(totalNodes);
			const sClassStack: NodeClass[][] = [];

			sNode[0] = startNode;
			sSuccIdx[0] = 0;
			sClassStack[0] = [];
			visited[startNode] = 1;
			let sp = 1;

			while (sp > 0) {
				const t = sp - 1;
				const nd = sNode[t];
				const si = sSuccIdx[t];
				const succs = successors[nd];
				const succEids = succEdgeIds[nd];

				if (si < succs.length) {
					sSuccIdx[t] = si + 1;
					const child = succs[si];
					const eid = succEids[si];
					const ec = edgeClass[eid];

					let classStack = sClassStack[t].slice();
					let exitingRegion = false;
					let popCount = 0;

					for (let j = classStack.length - 1; j >= 0; j--) {
						popCount++;
						if (classStack[j].edgeClassVal === ec) {
							exitEdge[eid] = 1;
							entryEdge[classStack[j].edgeId] = 1;
							exitingRegion = true;
							break;
						}
					}

					if (exitingRegion) {
						classStack = classStack.slice(0, classStack.length - popCount);
					}

					if (!visited[child]) {
						visited[child] = 1;
						classStack.push({
							nodeId: child,
							edgeId: eid,
							edgeClassVal: ec,
						});
						sNode[sp] = child;
						sSuccIdx[sp] = 0;
						sClassStack[sp] = classStack;
						sp++;
					}
				} else {
					sp--;
				}
			}
		};
		determineRegionBoundaries(root);
	}

	const regionOf = new Uint32Array(origN);
	const regions: SESERegion[] = [];
	regions.push({
		entryEdge: -1,
		exitEdge: -1,
		parent: -1,
		children: [],
		nodes: [],
	});

	{
		const visited = new Uint8Array(totalNodes);
		const sNode = new Int32Array(totalNodes);
		const sSuccIdx = new Int32Array(totalNodes);
		const sRegion = new Int32Array(totalNodes);

		visited[root] = 1;
		sNode[0] = root;
		sSuccIdx[0] = 0;
		sRegion[0] = 0;
		let sp = 1;

		if (root < origN) {
			regionOf[root] = 0;
			regions[0].nodes.push(root);
		}

		while (sp > 0) {
			const t = sp - 1;
			const nd = sNode[t];
			const si = sSuccIdx[t];
			const succs = successors[nd];
			const succEids = succEdgeIds[nd];

			if (si < succs.length) {
				sSuccIdx[t] = si + 1;
				const child = succs[si];
				const eid = succEids[si];
				let curRegion = sRegion[t];

				if (exitEdge[eid]) {
					const r = regions[curRegion];
					r.exitEdge = eid;
					if (r.parent >= 0) {
						curRegion = r.parent;
					}
				}

				if (entryEdge[eid]) {
					const newIdx = regions.length;
					regions.push({
						entryEdge: eid,
						exitEdge: -1,
						parent: curRegion,
						children: [],
						nodes: [],
					});
					regions[curRegion].children.push(newIdx);
					curRegion = newIdx;
				}

				if (!visited[child]) {
					visited[child] = 1;
					if (child < origN) {
						regionOf[child] = curRegion;
						regions[curRegion].nodes.push(child);
					}
					sNode[sp] = child;
					sSuccIdx[sp] = 0;
					sRegion[sp] = curRegion;
					sp++;
				}
			} else {
				sp--;
			}
		}
	}

	return { regions, regionOf };
}
