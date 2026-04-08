import type { CfgGraphRenderer } from "./cfgGraphRenderer";

export abstract class CfgCanvasLayer {
	protected readonly renderer: CfgGraphRenderer;
	protected readonly canvas: HTMLCanvasElement;
	protected readonly gl: WebGL2RenderingContext;
	private readonly boundRender: () => void;

	protected dirty = true;
	protected bboxCenterX = 0;
	protected bboxCenterY = 0;
	protected bboxRange = 1;
	protected invBBoxRange = 1;

	constructor(renderer: CfgGraphRenderer, zIndex: string, antialias: boolean) {
		this.renderer = renderer;
		const container = renderer.getContainer();

		this.canvas = document.createElement("canvas");
		this.canvas.style.position = "absolute";
		this.canvas.style.inset = "0";
		this.canvas.style.pointerEvents = "none";
		this.canvas.style.zIndex = zIndex;
		container.appendChild(this.canvas);

		const gl = this.canvas.getContext("webgl2", {
			alpha: true,
			premultipliedAlpha: false,
			antialias,
		});
		if (!gl) throw new Error("WebGL2 not supported");
		this.gl = gl;

		this.syncCanvasSize();
		this.boundRender = () => {
			if (this.syncCanvasSize()) this.dirty = true;
			this.onRender();
		};
		renderer.onRender(this.boundRender);
	}

	protected updateBBox(): void {
		const bbox = this.renderer.getBBox();
		const prevRange = this.bboxRange;
		this.bboxCenterX = (bbox.x[0] + bbox.x[1]) / 2;
		this.bboxCenterY = (bbox.y[0] + bbox.y[1]) / 2;
		this.bboxRange = Math.max(bbox.x[1] - bbox.x[0], bbox.y[1] - bbox.y[0], 1);
		this.invBBoxRange = 1 / this.bboxRange;
		if (this.bboxRange !== prevRange) this.dirty = true;
	}

	protected abstract onRender(): void;

	dispose(): void {
		this.renderer.offRender(this.boundRender);
		this.canvas.remove();
	}

	private syncCanvasSize(): boolean {
		const { width: w, height: h } = this.renderer.getDimensions();
		const dpr = window.devicePixelRatio || 1;
		const targetW = Math.round(w * dpr);
		const targetH = Math.round(h * dpr);
		if (this.canvas.width === targetW && this.canvas.height === targetH)
			return false;
		this.canvas.width = targetW;
		this.canvas.height = targetH;
		this.canvas.style.width = `${w}px`;
		this.canvas.style.height = `${h}px`;
		this.gl.viewport(0, 0, targetW, targetH);
		return true;
	}
}
