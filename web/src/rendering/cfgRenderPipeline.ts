import type { CfgNode } from "../lib/disassemblyGraph";
import { BlockTextPass } from "./blockTextProgram";
import { CfgGLContext } from "./cfgGLContext";
import type { CfgGraphRenderer } from "./cfgGraphRenderer";
import type { CfgRenderGraph } from "./cfgRenderGraph";
import { EdgePolylinePass } from "./edgePolylineProgram";
import { createFontAtlas } from "./fontAtlas";

export class CfgRenderPipeline {
	readonly textPass: BlockTextPass;
	readonly edgePass: EdgePolylinePass;
	private readonly glContext: CfgGLContext;
	private readonly renderer: CfgGraphRenderer;
	private readonly boundRender: () => void;

	constructor(
		renderer: CfgGraphRenderer,
		graph: CfgRenderGraph,
		nodesById: Map<string, CfgNode>,
	) {
		this.renderer = renderer;
		this.glContext = new CfgGLContext(renderer.getContainer(), "5");
		const gl = this.glContext.gl;
		const atlas = createFontAtlas(gl);
		this.edgePass = new EdgePolylinePass(gl, graph);
		this.textPass = new BlockTextPass(gl, renderer, graph, nodesById, atlas);
		gl.clearColor(0, 0, 0, 0);
		gl.enable(gl.BLEND);
		gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
		this.boundRender = () => this.onRender();
		renderer.onRender(this.boundRender);
	}

	private onRender(): void {
		const { width, height } = this.renderer.getDimensions();
		if (this.glContext.syncSize(width, height)) {
			this.edgePass.markDirty();
			this.textPass.markDirty();
		}
		const gl = this.glContext.gl;
		const canvas = this.glContext.canvas;
		gl.clear(gl.COLOR_BUFFER_BIT);
		this.edgePass.render(this.renderer, canvas);
		this.textPass.render(this.renderer);
	}

	dispose(): void {
		this.renderer.offRender(this.boundRender);
		this.textPass.dispose();
		this.edgePass.dispose();
		this.glContext.dispose();
	}
}
