import { computeDominators } from "./dominators";
import { type MutableGraph, UNDEFINED } from "./graph";

const MIN_IN_DEGREE_FOR_SPLIT = 3;

class RNode {
	nodeIds: number[] = [];
	radix: number[] = [];
	children = new Map<number, RNode>();
	readonly id: number;

	constructor(idCounter: { value: number }) {
		this.id = idCounter.value++;
	}

	newChild(idCounter: { value: number }, nodeId: number, key: number[]): void {
		const child = new RNode(idCounter);
		child.radix = key;
		child.nodeIds = [nodeId];
		this.children.set(key[0], child);
	}

	split(idCounter: { value: number }, nodeId: number, key: number[]): void {
		let i = 0;
		const limit = Math.min(this.radix.length, key.length);
		while (i < limit && this.radix[i] === key[i]) i++;

		const prefix = this.radix.slice(0, i);
		const suffix = this.radix.slice(i);
		const suffixKey = suffix[0];

		const demoted = new RNode(idCounter);
		demoted.children = this.children;
		demoted.nodeIds = this.nodeIds;
		demoted.radix = suffix;

		this.children = new Map();
		this.nodeIds = [];
		this.radix = prefix;
		this.children.set(suffixKey, demoted);

		if (i === key.length) {
			this.nodeIds.push(nodeId);
		} else {
			this.newChild(idCounter, nodeId, key.slice(i));
		}
	}
}

class RTree {
	root: RNode;
	private _idCounter = { value: 0 };

	constructor() {
		this.root = new RNode(this._idCounter);
	}

	insert(nodeId: number, keys: number[]): void {
		let cursor = this.root;
		let i = 0;

		while (i < keys.length) {
			const key = keys[i];
			const child = cursor.children.get(key);

			if (!child) {
				cursor.newChild(this._idCounter, nodeId, keys.slice(i));
				return;
			}

			cursor = child;

			if (startsWith(keys, i, cursor.radix)) {
				i += cursor.radix.length;
			} else {
				cursor.split(this._idCounter, nodeId, keys.slice(i));
				return;
			}
		}

		cursor.nodeIds.push(nodeId);
	}

	bfs(): RNode[] {
		const result: RNode[] = [];
		let current: RNode[] = [];
		let next: RNode[] = [this.root];

		while (next.length > 0) {
			[current, next] = [next, []];
			for (const node of current) {
				result.push(node);
				for (const child of node.children.values()) {
					next.push(child);
				}
			}
		}

		return result;
	}
}

function startsWith(keys: number[], offset: number, prefix: number[]): boolean {
	if (keys.length - offset < prefix.length) return false;
	for (let i = 0; i < prefix.length; i++) {
		if (keys[offset + i] !== prefix[i]) return false;
	}
	return true;
}

function buildDominatorKeys(
	graph: MutableGraph,
	root: number,
	idom: Uint32Array,
): number[][] {
	const keys: number[][] = new Array(graph.nodeCount);
	for (let i = 0; i < graph.nodeCount; i++) keys[i] = [];

	const stack: number[] = [];
	for (let node = 0; node < graph.nodeCount; node++) {
		if (keys[node].length > 0 || node === root) continue;
		if (idom[node] === UNDEFINED) continue;

		stack.length = 0;
		let cur = node;
		while (cur !== root && keys[cur].length === 0) {
			stack.push(cur);
			cur = idom[cur];
		}

		const base = keys[cur].slice();
		for (let i = stack.length - 1; i >= 0; i--) {
			const n = stack[i];
			base.push(idom[n]);
			keys[n] = base.slice();
		}
	}

	return keys;
}

function splitNode(
	graph: MutableGraph,
	node: number,
	keys: number[][],
): Map<number, number> {
	const phantomMap = new Map<number, number>();
	const rtree = new RTree();
	const preds = graph.predecessors(node);

	for (const parent of preds) {
		rtree.insert(parent, keys[parent]);
	}

	const rnodeToGraph = new Map<number, number>();
	const rnodes = rtree.bfs();

	for (let i = rnodes.length - 1; i >= 0; i--) {
		const rnode = rnodes[i];

		if (rnode.children.size === 0 && rnode.nodeIds.length === 1) {
			rnodeToGraph.set(rnode.id, rnode.nodeIds[0]);
			continue;
		}

		const phantom = graph.addNode();
		phantomMap.set(phantom, node);
		rnodeToGraph.set(rnode.id, phantom);

		for (const child of rnode.children.values()) {
			const childGraphId = rnodeToGraph.get(child.id)!;
			graph.addEdge(childGraphId, phantom);
		}

		for (const leafId of rnode.nodeIds) {
			graph.addEdge(leafId, phantom);
		}
	}

	for (const pred of [...preds]) {
		graph.removeEdge(pred, node);
	}

	const rootGraphId = rnodeToGraph.get(rtree.root.id)!;
	graph.addEdge(rootGraphId, node);

	return phantomMap;
}

export function createPhantomNodes(
	graph: MutableGraph,
	root: number,
): Map<number, number> {
	const idom = computeDominators(graph, root);
	const keys = buildDominatorKeys(graph, root, idom);
	const phantomNodeMap = new Map<number, number>();
	const nodeCount = graph.nodeCount;

	for (let node = 0; node < nodeCount; node++) {
		if (graph.inDegree(node) >= MIN_IN_DEGREE_FOR_SPLIT) {
			const localMap = splitNode(graph, node, keys);
			for (const [phantom, original] of localMap) {
				phantomNodeMap.set(phantom, original);
			}
			continue;
		}

		if (graph.outDegree(node) > 1 && graph.inDegree(node) > 1) {
			const phantom = graph.addNode();
			phantomNodeMap.set(phantom, node);

			const preds = [...graph.predecessors(node)];
			for (const pred of preds) {
				graph.removeEdge(pred, node);
				graph.addEdge(pred, phantom);
			}
			graph.addEdge(phantom, node);
		}
	}

	return phantomNodeMap;
}
