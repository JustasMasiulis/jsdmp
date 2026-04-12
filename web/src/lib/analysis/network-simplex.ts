// Network Simplex layer assignment based on GraphViz TSE93 paper.
// Partial implementation: feasible tree construction only (no leave/enter pivoting).

const UNRANKED = 0x7fffffff;

export function networkSimplex(
	nodeCount: number,
	succs: number[][],
	preds: number[][],
	root = 0,
): { layers: Int32Array; layerCount: number } {
	if (nodeCount === 0) return { layers: new Int32Array(0), layerCount: 0 };

	const ranks = new Int32Array(nodeCount);
	ranks.fill(UNRANKED);
	const inTree = new Uint8Array(nodeCount);

	initRank(nodeCount, succs, preds, ranks, root);

	const treeNodes: number[] = [];
	feasibleTree(nodeCount, succs, preds, ranks, inTree, treeNodes, root);

	return normalizeRanks(nodeCount, ranks);
}

function slack(from: number, to: number, ranks: Int32Array): number {
	return ranks[to] - ranks[from] - 1;
}

function initRank(
	nodeCount: number,
	succs: number[][],
	preds: number[][],
	ranks: Int32Array,
	root: number,
): void {
	ranks[root] = 0;

	let foundNodes = 1;
	let rank = 1;

	while (foundNodes < nodeCount) {
		for (let node = 0; node < nodeCount; node++) {
			if (ranks[node] < rank) {
				continue;
			}

			let canAssign = true;
			for (const parent of preds[node]) {
				if (ranks[parent] >= rank) {
					canAssign = false;
					break;
				}
			}

			if (canAssign) {
				ranks[node] = rank;
				foundNodes++;
			}
		}

		rank++;
	}
}

function feasibleTree(
	nodeCount: number,
	succs: number[][],
	preds: number[][],
	ranks: Int32Array,
	inTree: Uint8Array,
	treeNodes: number[],
	root: number,
): void {
	treeNodes.length = 0;
	inTree.fill(0);
	inTree[root] = 1;
	treeNodes.push(root);

	tightTreeBFS(succs, preds, ranks, inTree, treeNodes);

	while (treeNodes.length < nodeCount) {
		let bestEdgeFrom = -1;
		let bestEdgeTo = -1;
		let minSlack = 0x7fffffff;

		for (let node = 0; node < nodeCount; node++) {
			if (inTree[node]) continue;

			for (const pred of preds[node]) {
				if (!inTree[pred]) continue;
				const s = slack(pred, node, ranks);
				if (s < minSlack) {
					minSlack = s;
					bestEdgeFrom = pred;
					bestEdgeTo = node;
				}
			}

			for (const succ of succs[node]) {
				if (!inTree[succ]) continue;
				const s = slack(node, succ, ranks);
				if (s < minSlack) {
					minSlack = s;
					bestEdgeFrom = node;
					bestEdgeTo = succ;
				}
			}
		}

		if (bestEdgeFrom === -1) break;

		let delta = slack(bestEdgeFrom, bestEdgeTo, ranks);
		if (inTree[bestEdgeTo]) {
			delta = -delta;
		}

		for (const treeNode of treeNodes) {
			ranks[treeNode] += delta;
		}

		tightTreeBFS(succs, preds, ranks, inTree, treeNodes);
	}
}

function tightTreeBFS(
	succs: number[][],
	preds: number[][],
	ranks: Int32Array,
	inTree: Uint8Array,
	treeNodes: number[],
): void {
	for (let i = 0; i < treeNodes.length; i++) {
		const node = treeNodes[i];

		for (const child of succs[node]) {
			if (inTree[child]) continue;
			if (slack(node, child, ranks) !== 0) continue;
			inTree[child] = 1;
			treeNodes.push(child);
		}

		for (const parent of preds[node]) {
			if (inTree[parent]) continue;
			if (slack(parent, node, ranks) !== 0) continue;
			inTree[parent] = 1;
			treeNodes.push(parent);
		}
	}
}

function normalizeRanks(
	nodeCount: number,
	ranks: Int32Array,
): { layers: Int32Array; layerCount: number } {
	let maxRank = 0;
	for (let i = 0; i < nodeCount; i++) {
		if (ranks[i] > maxRank) maxRank = ranks[i];
	}

	const layers = new Int32Array(nodeCount);
	let layerCount = 0;
	for (let i = 0; i < nodeCount; i++) {
		const layer = maxRank - ranks[i] + 1;
		layers[i] = layer;
		if (layer > layerCount) layerCount = layer;
	}

	return { layers, layerCount: layerCount + 1 };
}
