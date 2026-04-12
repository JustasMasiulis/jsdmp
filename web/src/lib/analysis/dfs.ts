import { BitSet, type ReadonlyGraph, UNDEFINED } from "./graph";

export enum EdgeType {
	TREE = 0,
	BACK = 1,
	FORWARD = 2,
	CROSS = 3,
	NONE = 4,
}

export type DfsResult = {
	preOrder: Uint32Array;
	postOrder: Uint32Array;
	preNum: Uint32Array;
	postNum: Uint32Array;
	parent: Uint32Array;
	visitedCount: number;
};

export function dfs(graph: ReadonlyGraph, root: number): DfsResult {
	const n = graph.nodeCount;
	const preOrder = new Uint32Array(n).fill(UNDEFINED);
	const postOrder = new Uint32Array(n).fill(UNDEFINED);
	const preNum = new Uint32Array(n).fill(UNDEFINED);
	const postNum = new Uint32Array(n).fill(UNDEFINED);
	const parent = new Uint32Array(n).fill(UNDEFINED);

	if (n === 0)
		return { preOrder, postOrder, preNum, postNum, parent, visitedCount: 0 };

	const stackNode = new Uint32Array(n);
	const stackSuccIdx = new Uint32Array(n);
	let sp = 0;
	let preCtr = 0;
	let postCtr = 0;

	const visitRoot = (r: number) => {
		preNum[r] = preCtr;
		preOrder[preCtr++] = r;
		stackNode[0] = r;
		stackSuccIdx[0] = 0;
		sp = 1;

		while (sp > 0) {
			const top = sp - 1;
			const node = stackNode[top];
			const succIdx = stackSuccIdx[top];
			const succs = graph.successors(node);

			if (succIdx < succs.length) {
				stackSuccIdx[top] = succIdx + 1;
				const next = succs[succIdx];

				if (preNum[next] === UNDEFINED) {
					parent[next] = node;
					preNum[next] = preCtr;
					preOrder[preCtr++] = next;
					stackNode[sp] = next;
					stackSuccIdx[sp] = 0;
					sp++;
				}
			} else {
				sp--;
				postNum[node] = postCtr;
				postOrder[postCtr++] = node;
			}
		}
	};

	visitRoot(root);

	return { preOrder, postOrder, preNum, postNum, parent, visitedCount: preCtr };
}

export function computeEdgeOffsets(graph: ReadonlyGraph): Uint32Array {
	const n = graph.nodeCount;
	const offsets = new Uint32Array(n + 1);
	for (let u = 0; u < n; u++) {
		offsets[u + 1] = offsets[u] + graph.successors(u).length;
	}
	return offsets;
}

export function classifyEdges(
	graph: ReadonlyGraph,
	result: DfsResult,
): Uint8Array {
	const offsets = computeEdgeOffsets(graph);
	const totalEdges = offsets[graph.nodeCount];
	const types = new Uint8Array(totalEdges).fill(EdgeType.NONE);
	const { preNum } = result;
	const onStack = new BitSet(graph.nodeCount);

	const stackNode = new Uint32Array(graph.nodeCount);
	const stackSuccIdx = new Uint32Array(graph.nodeCount);
	let sp = 0;
	const visited = new BitSet(graph.nodeCount);

	const visitRoot = (r: number) => {
		visited.set(r);
		onStack.set(r);
		stackNode[0] = r;
		stackSuccIdx[0] = 0;
		sp = 1;

		while (sp > 0) {
			const top = sp - 1;
			const node = stackNode[top];
			const succIdx = stackSuccIdx[top];
			const succs = graph.successors(node);

			if (succIdx < succs.length) {
				stackSuccIdx[top] = succIdx + 1;
				const next = succs[succIdx];
				const edgeIdx = offsets[node] + succIdx;

				if (!visited.has(next)) {
					types[edgeIdx] = EdgeType.TREE;
					visited.set(next);
					onStack.set(next);
					stackNode[sp] = next;
					stackSuccIdx[sp] = 0;
					sp++;
				} else if (onStack.has(next)) {
					types[edgeIdx] = EdgeType.BACK;
				} else if (preNum[node] < preNum[next]) {
					types[edgeIdx] = EdgeType.FORWARD;
				} else {
					types[edgeIdx] = EdgeType.CROSS;
				}
			} else {
				sp--;
				onStack.clear(node);
			}
		}
	};

	if (result.visitedCount > 0) {
		visitRoot(result.preOrder[0]);
	}

	return types;
}

export function computeTopologicalOrder(
	graph: ReadonlyGraph,
	root: number,
): Uint32Array {
	const result = dfs(graph, root);
	const topo = new Uint32Array(result.visitedCount);
	for (let i = 0; i < result.visitedCount; i++) {
		topo[i] = result.postOrder[result.visitedCount - 1 - i];
	}
	return topo;
}
