export class CfgGLContext {
	readonly canvas: HTMLCanvasElement;
	readonly gl: WebGL2RenderingContext;

	constructor(container: HTMLElement, zIndex: string) {
		this.canvas = document.createElement("canvas");
		this.canvas.style.position = "absolute";
		this.canvas.style.inset = "0";
		this.canvas.style.pointerEvents = "none";
		this.canvas.style.zIndex = zIndex;
		container.appendChild(this.canvas);

		const gl = this.canvas.getContext("webgl2", {
			alpha: true,
			premultipliedAlpha: false,
			antialias: true,
		});
		if (!gl) throw new Error("WebGL2 not supported");
		this.gl = gl;
	}

	syncSize(width: number, height: number): boolean {
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

	dispose(): void {
		this.canvas.remove();
	}
}
