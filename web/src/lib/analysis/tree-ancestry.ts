export type TreeIntervals = {
	enter: Uint32Array;
	exit: Uint32Array;
};

export function buildTreeIntervals(
	children: ReadonlyArray<ArrayLike<number>>,
	root: number,
): TreeIntervals {
	const nodeCount = children.length;
	const enter = new Uint32Array(nodeCount);
	const exit = new Uint32Array(nodeCount);

	if (root < 0 || root >= nodeCount) {
		return { enter, exit };
	}

	const stackNode = new Int32Array(nodeCount);
	const stackChildIdx = new Int32Array(nodeCount);
	let tick = 0;
	let sp = 0;

	stackNode[0] = root;
	stackChildIdx[0] = 0;
	sp = 1;

	while (sp > 0) {
		const top = sp - 1;
		const node = stackNode[top];
		const childIdx = stackChildIdx[top];
		const nodeChildren = children[node];

		if (childIdx === 0) {
			enter[node] = tick++;
		}

		if (childIdx < nodeChildren.length) {
			stackChildIdx[top] = childIdx + 1;
			const child = nodeChildren[childIdx];
			stackNode[sp] = child;
			stackChildIdx[sp] = 0;
			sp++;
			continue;
		}

		exit[node] = tick++;
		sp--;
	}

	return { enter, exit };
}

export function isStrictAncestor(
	intervals: TreeIntervals,
	node: number,
	ancestor: number,
): boolean {
	if (node === ancestor) {
		return false;
	}

	return (
		intervals.enter[ancestor] <= intervals.enter[node] &&
		intervals.exit[node] <= intervals.exit[ancestor]
	);
}
