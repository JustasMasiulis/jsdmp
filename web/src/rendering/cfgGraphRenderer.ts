import type { CfgRenderGraph } from "./cfgRenderGraph";

type CameraState = { x: number; y: number; ratio: number };
type Dimensions = { width: number; height: number };
type Coords = { x: number; y: number };
type BBox = { x: [number, number]; y: [number, number] };

export class CfgGraphRenderer {
	private readonly container: HTMLElement;
	private readonly graph: CfgRenderGraph;
	private camera: CameraState = { x: 0.5, y: 0.5, ratio: 1 };
	private readonly matrix = new Float32Array(9);
	private width = 0;
	private height = 0;
	private minRatio: number;
	private maxRatio: number;

	private bboxCenterX = 0;
	private bboxCenterY = 0;
	private bboxRange = 1;

	private renderCallbacks: Array<() => void> = [];
	private frameRequested = false;
	private disposed = false;

	private dragging = false;
	private dragLastX = 0;
	private dragLastY = 0;

	private touchIds: number[] = [];
	private touchLastCenterX = 0;
	private touchLastCenterY = 0;
	private touchLastDist = 0;

	private cachedRect: DOMRect = new DOMRect();

	private readonly resizeObserver: ResizeObserver;
	private readonly boundWheel: (e: WheelEvent) => void;
	private readonly boundMouseDown: (e: MouseEvent) => void;
	private readonly boundMouseMove: (e: MouseEvent) => void;
	private readonly boundMouseUp: (e: MouseEvent) => void;
	private readonly boundTouchStart: (e: TouchEvent) => void;
	private readonly boundTouchMove: (e: TouchEvent) => void;
	private readonly boundTouchEnd: (e: TouchEvent) => void;

	constructor(
		container: HTMLElement,
		graph: CfgRenderGraph,
		opts: { minRatio: number; maxRatio: number },
	) {
		this.container = container;
		this.graph = graph;
		this.minRatio = opts.minRatio;
		this.maxRatio = opts.maxRatio;

		const bbox = graph.bbox;
		this.bboxCenterX = (bbox.x[0] + bbox.x[1]) / 2;
		this.bboxCenterY = (bbox.y[0] + bbox.y[1]) / 2;
		this.bboxRange = Math.max(bbox.x[1] - bbox.x[0], bbox.y[1] - bbox.y[0], 1);

		this.syncDimensions();
		this.recomputeMatrix();

		this.boundWheel = (e) => this.handleWheel(e);
		this.boundMouseDown = (e) => this.handleMouseDown(e);
		this.boundMouseMove = (e) => this.handleMouseMove(e);
		this.boundMouseUp = (e) => this.handleMouseUp(e);
		this.boundTouchStart = (e) => this.handleTouchStart(e);
		this.boundTouchMove = (e) => this.handleTouchMove(e);
		this.boundTouchEnd = (e) => this.handleTouchEnd(e);

		container.addEventListener("wheel", this.boundWheel, { passive: false });
		container.addEventListener("mousedown", this.boundMouseDown);
		window.addEventListener("mousemove", this.boundMouseMove);
		window.addEventListener("mouseup", this.boundMouseUp);
		container.addEventListener("touchstart", this.boundTouchStart, {
			passive: false,
		});
		container.addEventListener("touchmove", this.boundTouchMove, {
			passive: false,
		});
		container.addEventListener("touchend", this.boundTouchEnd);
		container.addEventListener("touchcancel", this.boundTouchEnd);

		this.resizeObserver = new ResizeObserver(() => {
			this.updateCachedRect();
			if (this.syncDimensions()) {
				this.recomputeMatrix();
				this.requestRender();
			}
		});
		this.resizeObserver.observe(container);
	}

	getContainer(): HTMLElement {
		return this.container;
	}

	setCameraState(state: CameraState): void {
		this.camera = { ...state };
		this.recomputeMatrix();
		this.requestRender();
	}

	getCameraRatio(): number {
		return this.camera.ratio;
	}

	getDimensions(): Dimensions {
		return { width: this.width, height: this.height };
	}

	setZoomBounds(minRatio: number, maxRatio: number): void {
		this.minRatio = minRatio;
		this.maxRatio = maxRatio;
	}

	getBBox(): BBox {
		return this.graph.bbox;
	}

	viewportToGraph(vp: Coords): Coords {
		const w = this.width;
		const h = this.height;
		if (w <= 0 || h <= 0) return { x: 0, y: 0 };

		const clipX = (vp.x / w) * 2 - 1;
		const clipY = 1 - (vp.y / h) * 2;

		const m = this.matrix;
		const det = m[0] * m[4] - m[3] * m[1];
		if (det === 0) return { x: 0, y: 0 };

		const cx = clipX - m[6];
		const cy = clipY - m[7];
		const normX = (m[4] * cx - m[3] * cy) / det;
		const normY = (m[0] * cy - m[1] * cx) / det;

		const range = this.bboxRange;
		return {
			x: (normX - 0.5) * range + this.bboxCenterX,
			y: (normY - 0.5) * range + this.bboxCenterY,
		};
	}

	graphToViewport(gp: Coords): Coords {
		const range = this.bboxRange;
		const normX = 0.5 + (gp.x - this.bboxCenterX) / range;
		const normY = 0.5 + (gp.y - this.bboxCenterY) / range;

		const m = this.matrix;
		const clipX = m[0] * normX + m[3] * normY + m[6];
		const clipY = m[1] * normX + m[4] * normY + m[7];

		return {
			x: ((clipX + 1) / 2) * this.width,
			y: ((1 - clipY) / 2) * this.height,
		};
	}

	getRenderParams(): { matrix: Float32Array; width: number; height: number } {
		return { matrix: this.matrix, width: this.width, height: this.height };
	}

	requestRender(): void {
		if (this.frameRequested || this.disposed) return;
		this.frameRequested = true;
		requestAnimationFrame(() => {
			this.frameRequested = false;
			if (this.disposed) return;
			if (this.syncDimensions()) this.recomputeMatrix();
			const cbs = this.renderCallbacks.slice();
			for (let i = 0; i < cbs.length; i++) cbs[i]();
		});
	}

	onRender(fn: () => void): void {
		this.renderCallbacks.push(fn);
	}

	offRender(fn: () => void): void {
		const idx = this.renderCallbacks.indexOf(fn);
		if (idx >= 0) this.renderCallbacks.splice(idx, 1);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.resizeObserver.disconnect();
		this.container.removeEventListener("wheel", this.boundWheel);
		this.container.removeEventListener("mousedown", this.boundMouseDown);
		window.removeEventListener("mousemove", this.boundMouseMove);
		window.removeEventListener("mouseup", this.boundMouseUp);
		this.container.removeEventListener("touchstart", this.boundTouchStart);
		this.container.removeEventListener("touchmove", this.boundTouchMove);
		this.container.removeEventListener("touchend", this.boundTouchEnd);
		this.container.removeEventListener("touchcancel", this.boundTouchEnd);
		this.renderCallbacks = [];
	}

	private updateCachedRect(): void {
		this.cachedRect = this.container.getBoundingClientRect();
	}

	private syncDimensions(): boolean {
		const w = this.container.clientWidth;
		const h = this.container.clientHeight;
		if (w === this.width && h === this.height) return false;
		this.width = w;
		this.height = h;
		return true;
	}

	private recomputeMatrix(): void {
		const w = this.width;
		const h = this.height;
		if (w <= 0 || h <= 0) return;

		const minDim = Math.min(w, h);
		const ratio = this.camera.ratio;
		const sx = (2 * minDim) / (w * ratio);
		const sy = (2 * minDim) / (h * ratio);

		const m = this.matrix;
		m[0] = sx;
		m[1] = 0;
		m[2] = 0;
		m[3] = 0;
		m[4] = sy;
		m[5] = 0;
		m[6] = -this.camera.x * sx;
		m[7] = -this.camera.y * sy;
		m[8] = 1;
	}

	private handleWheel(e: WheelEvent): void {
		e.preventDefault();
		const ZOOM_SPEED = 0.0015;

		const vx = e.clientX - this.cachedRect.left;
		const vy = e.clientY - this.cachedRect.top;
		const graphBefore = this.viewportToGraph({ x: vx, y: vy });

		const range = this.bboxRange;
		const normBefore = {
			x: 0.5 + (graphBefore.x - this.bboxCenterX) / range,
			y: 0.5 + (graphBefore.y - this.bboxCenterY) / range,
		};

		const newRatio = Math.max(
			this.minRatio,
			Math.min(
				this.maxRatio,
				this.camera.ratio * Math.exp(e.deltaY * ZOOM_SPEED),
			),
		);

		this.camera.x =
			normBefore.x -
			((normBefore.x - this.camera.x) * newRatio) / this.camera.ratio;
		this.camera.y =
			normBefore.y -
			((normBefore.y - this.camera.y) * newRatio) / this.camera.ratio;
		this.camera.ratio = newRatio;

		this.recomputeMatrix();
		this.requestRender();
	}

	private handleMouseDown(e: MouseEvent): void {
		if (e.button !== 0) return;
		e.preventDefault();
		this.updateCachedRect();
		this.dragging = true;
		this.dragLastX = e.clientX;
		this.dragLastY = e.clientY;
	}

	private handleMouseMove(e: MouseEvent): void {
		if (!this.dragging) return;
		e.preventDefault();
		const dx = e.clientX - this.dragLastX;
		const dy = e.clientY - this.dragLastY;
		this.dragLastX = e.clientX;
		this.dragLastY = e.clientY;

		const w = this.width;
		const h = this.height;
		if (w <= 0 || h <= 0) return;

		const minDim = Math.min(w, h);
		const ratio = this.camera.ratio;
		this.camera.x -= (dx * ratio) / minDim;
		this.camera.y += (dy * ratio) / minDim;

		this.recomputeMatrix();
		this.requestRender();
	}

	private handleMouseUp(_e: MouseEvent): void {
		if (!this.dragging) return;
		this.dragging = false;
	}

	private getTrackedTouches(e: TouchEvent): Touch[] {
		const out: Touch[] = [];
		for (const id of this.touchIds) {
			for (let i = 0; i < e.touches.length; i++) {
				if (e.touches[i].identifier === id) {
					out.push(e.touches[i]);
					break;
				}
			}
		}
		return out;
	}

	private syncTouchAnchor(tracked: Touch[]): void {
		if (tracked.length === 1) {
			this.touchLastCenterX = tracked[0].clientX - this.cachedRect.left;
			this.touchLastCenterY = tracked[0].clientY - this.cachedRect.top;
			this.touchLastDist = 0;
		} else if (tracked.length >= 2) {
			this.touchLastCenterX =
				(tracked[0].clientX + tracked[1].clientX) / 2 - this.cachedRect.left;
			this.touchLastCenterY =
				(tracked[0].clientY + tracked[1].clientY) / 2 - this.cachedRect.top;
			this.touchLastDist = Math.hypot(
				tracked[1].clientX - tracked[0].clientX,
				tracked[1].clientY - tracked[0].clientY,
			);
		}
	}

	private handleTouchStart(e: TouchEvent): void {
		e.preventDefault();
		if (this.touchIds.length >= 2) return;

		for (let i = 0; i < e.changedTouches.length; i++) {
			const t = e.changedTouches[i];
			if (this.touchIds.length < 2 && !this.touchIds.includes(t.identifier))
				this.touchIds.push(t.identifier);
		}

		const tracked = this.getTrackedTouches(e);
		if (tracked.length === 0) return;

		this.updateCachedRect();
		this.syncTouchAnchor(tracked);
	}

	private handleTouchMove(e: TouchEvent): void {
		e.preventDefault();
		const tracked = this.getTrackedTouches(e);
		if (tracked.length === 0) return;

		let cx: number;
		let cy: number;
		let dist: number;

		if (tracked.length === 1) {
			cx = tracked[0].clientX - this.cachedRect.left;
			cy = tracked[0].clientY - this.cachedRect.top;
			dist = 0;
		} else {
			cx = (tracked[0].clientX + tracked[1].clientX) / 2 - this.cachedRect.left;
			cy = (tracked[0].clientY + tracked[1].clientY) / 2 - this.cachedRect.top;
			dist = Math.hypot(
				tracked[1].clientX - tracked[0].clientX,
				tracked[1].clientY - tracked[0].clientY,
			);
		}

		const dx = cx - this.touchLastCenterX;
		const dy = cy - this.touchLastCenterY;

		const w = this.width;
		const h = this.height;
		if (w > 0 && h > 0) {
			const minDim = Math.min(w, h);
			const ratio = this.camera.ratio;
			this.camera.x -= (dx * ratio) / minDim;
			this.camera.y += (dy * ratio) / minDim;
		}

		if (tracked.length >= 2 && this.touchLastDist > 0 && dist > 0) {
			const graphBefore = this.viewportToGraph({ x: cx, y: cy });
			const normBefore = {
				x: 0.5 + (graphBefore.x - this.bboxCenterX) / this.bboxRange,
				y: 0.5 + (graphBefore.y - this.bboxCenterY) / this.bboxRange,
			};

			const newRatio = Math.max(
				this.minRatio,
				Math.min(
					this.maxRatio,
					this.camera.ratio * (this.touchLastDist / dist),
				),
			);

			this.camera.x =
				normBefore.x -
				((normBefore.x - this.camera.x) * newRatio) / this.camera.ratio;
			this.camera.y =
				normBefore.y -
				((normBefore.y - this.camera.y) * newRatio) / this.camera.ratio;
			this.camera.ratio = newRatio;
		}

		this.touchLastCenterX = cx;
		this.touchLastCenterY = cy;
		this.touchLastDist = dist;

		this.recomputeMatrix();
		this.requestRender();
	}

	private handleTouchEnd(e: TouchEvent): void {
		for (let i = 0; i < e.changedTouches.length; i++) {
			const idx = this.touchIds.indexOf(e.changedTouches[i].identifier);
			if (idx >= 0) this.touchIds.splice(idx, 1);
		}

		const tracked = this.getTrackedTouches(e);
		if (tracked.length > 0) this.syncTouchAnchor(tracked);
	}
}
