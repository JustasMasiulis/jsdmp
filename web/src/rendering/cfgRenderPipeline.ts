import type { CfgNode } from "../lib/disassemblyGraph";
import { BlockTextPass } from "./blockTextProgram";
import type { CfgGraphRenderer } from "./cfgGraphRenderer";
import type { CfgRenderGraph } from "./cfgRenderGraph";
import { EdgePolylinePass } from "./edgePolylineProgram";
import { createFontAtlas } from "./fontAtlas";

export class CfgRenderPipeline {
	readonly textPass: BlockTextPass;
	readonly edgePass: EdgePolylinePass;
	private readonly canvas: HTMLCanvasElement;
	private readonly gl: WebGL2RenderingContext;
	private readonly renderer: CfgGraphRenderer;
	private readonly boundRender: () => void;

	constructor(
		renderer: CfgGraphRenderer,
		graph: CfgRenderGraph,
		nodesById: Map<string, CfgNode>,
	) {
		this.renderer = renderer;

		const canvas = document.createElement("canvas");
		canvas.style.position = "absolute";
		canvas.style.inset = "0";
		canvas.style.pointerEvents = "none";
		canvas.style.zIndex = "5";
		renderer.getContainer().appendChild(canvas);
		this.canvas = canvas;

		const gl = canvas.getContext("webgl2", {
			alpha: true,
			premultipliedAlpha: false,
			antialias: true,
		});
		if (!gl) throw new Error("WebGL2 not supported");
		this.gl = gl;

		const atlas = createFontAtlas(gl);
		this.edgePass = new EdgePolylinePass(gl, graph);
		this.textPass = new BlockTextPass(gl, renderer, graph, nodesById, atlas);
		gl.clearColor(0, 0, 0, 0);
		gl.enable(gl.BLEND);
		gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
		this.boundRender = () => this.onRender();
		renderer.onRender(this.boundRender);
	}

	private syncSize(width: number, height: number): boolean {
		const dpr = window.devicePixelRatio || 1;
		const targetW = Math.round(width * dpr);
		const targetH = Math.round(height * dpr);
		if (this.canvas.width === targetW && this.canvas.height === targetH)
			return false;
		this.canvas.width = targetW;
		this.canvas.height = targetH;
		this.canvas.style.width = `${width}px`;
		this.canvas.style.height = `${height}px`;
		this.gl.viewport(0, 0, targetW, targetH);
		return true;
	}

	private onRender(): void {
		const { width, height } = this.renderer.getDimensions();
		if (this.syncSize(width, height)) {
			this.edgePass.markDirty();
			this.textPass.markDirty();
		}
		this.gl.clear(this.gl.COLOR_BUFFER_BIT);
		this.edgePass.render(this.renderer, this.canvas);
		this.textPass.render(this.renderer);
	}

	dispose(): void {
		this.renderer.offRender(this.boundRender);
		this.textPass.dispose();
		this.edgePass.dispose();
		this.canvas.remove();
	}
}
