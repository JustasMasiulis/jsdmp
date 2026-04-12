import { type ReadonlyGraph, UNDEFINED } from "./graph";

export function computeDominators(
	graph: ReadonlyGraph,
	root: number,
): Uint32Array {
	const nodeCount = graph.nodeCount;
	const idom = new Uint32Array(nodeCount).fill(UNDEFINED);

	if (nodeCount === 0) return idom;

	const dfsNum = new Uint32Array(nodeCount).fill(UNDEFINED);
	const vertex = new Uint32Array(nodeCount);
	const dfsParent = new Uint32Array(nodeCount).fill(UNDEFINED);

	let dfsCount = 0;
	const dfsStack: number[] = [root];
	while (dfsStack.length > 0) {
		const node = dfsStack.pop()!;
		if (dfsNum[node] !== UNDEFINED) continue;

		dfsNum[node] = dfsCount;
		vertex[dfsCount] = node;
		dfsCount++;

		const succs = graph.successors(node);
		for (let i = succs.length - 1; i >= 0; i--) {
			const succ = succs[i];
			if (dfsNum[succ] === UNDEFINED) {
				dfsParent[succ] = node;
				dfsStack.push(succ);
			}
		}
	}

	if (dfsCount <= 1) {
		if (dfsCount === 1) idom[root] = root;
		return idom;
	}

	const semi = new Uint32Array(nodeCount);
	const ancestor = new Uint32Array(nodeCount).fill(UNDEFINED);
	const label = new Uint32Array(nodeCount);
	const buckets: number[][] = new Array(nodeCount);

	for (let v = 0; v < nodeCount; v++) {
		semi[v] = dfsNum[v];
		label[v] = v;
		buckets[v] = [];
	}

	function compress(v: number): void {
		const stack: number[] = [];
		let u = v;
		while (ancestor[ancestor[u]] !== UNDEFINED) {
			stack.push(u);
			u = ancestor[u];
		}
		for (let i = stack.length - 1; i >= 0; i--) {
			u = stack[i];
			if (semi[label[ancestor[u]]] < semi[label[u]]) {
				label[u] = label[ancestor[u]];
			}
			ancestor[u] = ancestor[ancestor[u]];
		}
	}

	function evalNode(v: number): number {
		if (ancestor[v] === UNDEFINED) return v;
		compress(v);
		return label[v];
	}

	for (let i = dfsCount - 1; i >= 1; i--) {
		const w = vertex[i];
		const parent = dfsParent[w];

		const preds = graph.predecessors(w);
		for (let j = 0; j < preds.length; j++) {
			const v = preds[j];
			if (dfsNum[v] === UNDEFINED) continue;
			const u = evalNode(v);
			if (semi[u] < semi[w]) {
				semi[w] = semi[u];
			}
		}

		buckets[vertex[semi[w]]]?.push(w);

		ancestor[w] = parent;

		const bucket = buckets[parent];
		for (let j = 0; j < bucket.length; j++) {
			const v = bucket[j];
			const u = evalNode(v);
			idom[v] = semi[u] < semi[v] ? u : parent;
		}
		bucket.length = 0;
	}

	for (let i = 1; i < dfsCount; i++) {
		const w = vertex[i];
		if (idom[w] !== vertex[semi[w]]) {
			idom[w] = idom[idom[w]];
		}
	}

	idom[root] = root;
	return idom;
}

export function buildDominatorTree(
	idom: Uint32Array,
	root: number,
): Uint32Array[] {
	const nodeCount = idom.length;
	const childCounts = new Uint32Array(nodeCount);

	for (let v = 0; v < nodeCount; v++) {
		if (v !== root && idom[v] !== UNDEFINED) {
			childCounts[idom[v]]++;
		}
	}

	const children: Uint32Array[] = new Array(nodeCount);
	const positions = new Uint32Array(nodeCount);
	for (let v = 0; v < nodeCount; v++) {
		children[v] = new Uint32Array(childCounts[v]);
	}

	for (let v = 0; v < nodeCount; v++) {
		if (v !== root && idom[v] !== UNDEFINED) {
			const parent = idom[v];
			const pos = positions[parent];
			children[parent][pos] = v;
			positions[parent] = pos + 1;
		}
	}

	return children;
}

export function dominatorDepth(idom: Uint32Array, root: number): Uint32Array {
	const nodeCount = idom.length;
	const depth = new Uint32Array(nodeCount).fill(UNDEFINED);
	const tree = buildDominatorTree(idom, root);

	depth[root] = 0;
	const queue: number[] = [root];
	let head = 0;

	while (head < queue.length) {
		const node = queue[head++];
		const kids = tree[node];
		const nextDepth = depth[node] + 1;
		for (let i = 0; i < kids.length; i++) {
			const child = kids[i];
			depth[child] = nextDepth;
			queue.push(child);
		}
	}

	return depth;
}
