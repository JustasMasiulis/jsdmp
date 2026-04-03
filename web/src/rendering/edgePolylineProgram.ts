import type Graph from "graphology";
import type Sigma from "sigma";

const VERTEX_SHADER = `
attribute vec2 a_position;
attribute vec2 a_normal;
attribute vec4 a_color;

uniform mat3 u_matrix;
uniform float u_thickness;
uniform vec2 u_resolution;

varying vec4 v_color;

void main() {
    vec3 graphPos = u_matrix * vec3(a_position, 1.0);
    vec2 clipPos = graphPos.xy / graphPos.z;

    vec2 screenPos = (clipPos * 0.5 + 0.5) * u_resolution;
    screenPos += a_normal * u_thickness;

    vec2 finalClip = (screenPos / u_resolution) * 2.0 - 1.0;
    gl_Position = vec4(finalClip, 0.0, 1.0);
    v_color = a_color;
}
`;

const FRAGMENT_SHADER = `
precision mediump float;
varying vec4 v_color;

void main() {
    gl_FragColor = v_color;
}
`;

const FLOATS_PER_VERTEX = 8;
const ARROW_WIDTH = 8;
const ARROW_HEIGHT = 6;
const ARROW_TRIM = ARROW_WIDTH;

type PolylinePoint = { x: number; y: number };

type EdgeAttributes = {
	color: string;
	polylinePoints: PolylinePoint[];
};

function parseColor(hex: string): [number, number, number, number] {
	const r = Number.parseInt(hex.slice(1, 3), 16) / 255;
	const g = Number.parseInt(hex.slice(3, 5), 16) / 255;
	const b = Number.parseInt(hex.slice(5, 7), 16) / 255;
	return [r, g, b, 1.0];
}

function compileShader(
	gl: WebGL2RenderingContext,
	type: number,
	source: string,
): WebGLShader {
	const shader = gl.createShader(type);
	if (!shader) throw new Error("Failed to create shader");
	gl.shaderSource(shader, source);
	gl.compileShader(shader);
	if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
		const info = gl.getShaderInfoLog(shader);
		gl.deleteShader(shader);
		throw new Error(`Shader compilation failed: ${info}`);
	}
	return shader;
}

function createProgram(
	gl: WebGL2RenderingContext,
	vertSrc: string,
	fragSrc: string,
): WebGLProgram {
	const vert = compileShader(gl, gl.VERTEX_SHADER, vertSrc);
	const frag = compileShader(gl, gl.FRAGMENT_SHADER, fragSrc);
	const program = gl.createProgram();
	if (!program) throw new Error("Failed to create program");
	gl.attachShader(program, vert);
	gl.attachShader(program, frag);
	gl.linkProgram(program);
	if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
		const info = gl.getProgramInfoLog(program);
		gl.deleteProgram(program);
		throw new Error(`Program link failed: ${info}`);
	}
	gl.deleteShader(vert);
	gl.deleteShader(frag);
	return program;
}

function trimPolylineEnd(
	points: PolylinePoint[],
	trimLength: number,
): PolylinePoint[] {
	if (points.length < 2) return points;

	const result = points.slice();
	let remaining = trimLength;

	while (remaining > 0 && result.length >= 2) {
		const last = result[result.length - 1];
		const prev = result[result.length - 2];
		const dx = last.x - prev.x;
		const dy = last.y - prev.y;
		const segLen = Math.sqrt(dx * dx + dy * dy);

		if (segLen <= remaining) {
			remaining -= segLen;
			result.pop();
		} else {
			const ratio = (segLen - remaining) / segLen;
			result[result.length - 1] = {
				x: prev.x + dx * ratio,
				y: prev.y + dy * ratio,
			};
			remaining = 0;
		}
	}

	return result;
}

function writeVertex(
	buf: Float32Array,
	offset: number,
	x: number,
	y: number,
	nx: number,
	ny: number,
	r: number,
	g: number,
	b: number,
	a: number,
): number {
	buf[offset] = x;
	buf[offset + 1] = y;
	buf[offset + 2] = nx;
	buf[offset + 3] = ny;
	buf[offset + 4] = r;
	buf[offset + 5] = g;
	buf[offset + 6] = b;
	buf[offset + 7] = a;
	return offset + FLOATS_PER_VERTEX;
}

function writeArrowVertices(
	buf: Float32Array,
	offset: number,
	points: PolylinePoint[],
	r: number,
	g: number,
	b: number,
	a: number,
	scale: number,
): number {
	if (points.length < 2) return offset;

	const tip = points[points.length - 1];
	const prev = points[points.length - 2];
	const dx = tip.x - prev.x;
	const dy = tip.y - prev.y;
	const len = Math.sqrt(dx * dx + dy * dy);
	if (len === 0) return offset;

	const dirX = dx / len;
	const dirY = dy / len;
	const halfW = (ARROW_HEIGHT * scale) / 2;
	const arrowLen = ARROW_WIDTH * scale;
	const baseX = tip.x - dirX * arrowLen;
	const baseY = tip.y - dirY * arrowLen;
	const perpX = -dirY;
	const perpY = dirX;

	offset = writeVertex(buf, offset, tip.x, tip.y, 0, 0, r, g, b, a);
	offset = writeVertex(
		buf,
		offset,
		baseX + perpX * halfW,
		baseY + perpY * halfW,
		0,
		0,
		r,
		g,
		b,
		a,
	);
	offset = writeVertex(
		buf,
		offset,
		baseX - perpX * halfW,
		baseY - perpY * halfW,
		0,
		0,
		r,
		g,
		b,
		a,
	);
	return offset;
}

function writeSegmentQuad(
	buf: Float32Array,
	offset: number,
	p0: PolylinePoint,
	p1: PolylinePoint,
	r: number,
	g: number,
	b: number,
	a: number,
): number {
	const dx = p1.x - p0.x;
	const dy = p1.y - p0.y;
	const len = Math.sqrt(dx * dx + dy * dy);
	if (len === 0) return offset;

	const nx = -dy / len;
	const ny = dx / len;

	offset = writeVertex(buf, offset, p0.x, p0.y, nx, ny, r, g, b, a);
	offset = writeVertex(buf, offset, p1.x, p1.y, nx, ny, r, g, b, a);
	offset = writeVertex(buf, offset, p0.x, p0.y, -nx, -ny, r, g, b, a);
	offset = writeVertex(buf, offset, p0.x, p0.y, -nx, -ny, r, g, b, a);
	offset = writeVertex(buf, offset, p1.x, p1.y, nx, ny, r, g, b, a);
	offset = writeVertex(buf, offset, p1.x, p1.y, -nx, -ny, r, g, b, a);
	return offset;
}

export class EdgePolylineRenderer {
	private sigma: Sigma;
	private graph: Graph;
	private canvas: HTMLCanvasElement;
	private gl: WebGL2RenderingContext;
	private program: WebGLProgram;
	private vbo: WebGLBuffer;
	private vertexCount = 0;
	private dirty = true;

	private aPosition: number;
	private aNormal: number;
	private aColor: number;
	private uMatrix: WebGLUniformLocation;
	private uThickness: WebGLUniformLocation;
	private uResolution: WebGLUniformLocation;

	private boundRender: () => void;
	private resizeObserver: ResizeObserver;

	constructor(sigma: Sigma, graph: Graph) {
		this.sigma = sigma;
		this.graph = graph;

		const container = sigma.getContainer();
		this.canvas = document.createElement("canvas");
		this.canvas.style.position = "absolute";
		this.canvas.style.inset = "0";
		this.canvas.style.pointerEvents = "none";
		this.canvas.style.zIndex = "5";
		container.appendChild(this.canvas);

		const gl = this.canvas.getContext("webgl2", {
			alpha: true,
			premultipliedAlpha: false,
			antialias: true,
		});
		if (!gl) throw new Error("WebGL2 not available");
		this.gl = gl;

		this.program = createProgram(gl, VERTEX_SHADER, FRAGMENT_SHADER);

		this.aPosition = gl.getAttribLocation(this.program, "a_position");
		this.aNormal = gl.getAttribLocation(this.program, "a_normal");
		this.aColor = gl.getAttribLocation(this.program, "a_color");

		const uMatrix = gl.getUniformLocation(this.program, "u_matrix");
		const uThickness = gl.getUniformLocation(this.program, "u_thickness");
		const uResolution = gl.getUniformLocation(this.program, "u_resolution");
		if (!uMatrix || !uThickness || !uResolution)
			throw new Error("Failed to get uniform locations");
		this.uMatrix = uMatrix;
		this.uThickness = uThickness;
		this.uResolution = uResolution;

		const vbo = gl.createBuffer();
		if (!vbo) throw new Error("Failed to create buffer");
		this.vbo = vbo;

		this.boundRender = () => this.render();
		sigma.on("afterRender", this.boundRender);

		this.resizeObserver = new ResizeObserver(() => {
			if (this.syncCanvasSize()) {
				this.sigma.refresh();
			}
		});
		this.resizeObserver.observe(container);
		this.syncCanvasSize();

		graph.on("edgeAdded", () => {
			this.dirty = true;
		});
		graph.on("edgeDropped", () => {
			this.dirty = true;
		});
		graph.on("edgeAttributesUpdated", () => {
			this.dirty = true;
		});
		graph.on("cleared", () => {
			this.dirty = true;
		});
	}

	private syncCanvasSize(): boolean {
		const container = this.sigma.getContainer();
		const width = container.clientWidth;
		const height = container.clientHeight;
		const dpr = window.devicePixelRatio || 1;
		const targetW = Math.round(width * dpr);
		const targetH = Math.round(height * dpr);
		if (this.canvas.width === targetW && this.canvas.height === targetH) {
			return false;
		}
		this.canvas.width = targetW;
		this.canvas.height = targetH;
		this.canvas.style.width = `${width}px`;
		this.canvas.style.height = `${height}px`;
		this.gl.viewport(0, 0, targetW, targetH);
		this.dirty = true;
		return true;
	}

	markDirty() {
		this.dirty = true;
	}

	private normalizePoint(p: PolylinePoint): PolylinePoint {
		const cx = this.bboxCenterX;
		const cy = this.bboxCenterY;
		const r = this.bboxRange;
		return {
			x: 0.5 + (p.x - cx) / r,
			y: 0.5 + (p.y - cy) / r,
		};
	}

	private bboxCenterX = 0;
	private bboxCenterY = 0;
	private bboxRange = 1;

	private updateBBox() {
		const bbox = this.sigma.getCustomBBox();
		if (!bbox) return;
		const prevRange = this.bboxRange;
		this.bboxCenterX = (bbox.x[0] + bbox.x[1]) / 2;
		this.bboxCenterY = (bbox.y[0] + bbox.y[1]) / 2;
		this.bboxRange = Math.max(
			bbox.x[1] - bbox.x[0],
			bbox.y[1] - bbox.y[0],
			1,
		);
		if (this.bboxRange !== prevRange) {
			this.dirty = true;
		}
	}

	private rebuildBuffer() {
		this.updateBBox();

		let totalSegments = 0;
		let totalArrows = 0;

		this.graph.forEachEdge((_edge, attrs) => {
			const { polylinePoints } = attrs as unknown as EdgeAttributes;
			if (!polylinePoints || polylinePoints.length < 2) return;
			totalSegments += Math.max(0, polylinePoints.length - 2);
			totalArrows += 1;
		});

		const vertexCount = (totalSegments + totalArrows) * 6 + totalArrows * 3;
		const buf = new Float32Array(vertexCount * FLOATS_PER_VERTEX);
		let offset = 0;

		const normTrim = ARROW_TRIM / this.bboxRange;

		this.graph.forEachEdge((_edge, attrs) => {
			const { polylinePoints, color } = attrs as unknown as EdgeAttributes;
			if (!polylinePoints || polylinePoints.length < 2) return;

			const [r, g, b, a] = parseColor(color);

			const npts = polylinePoints.map((p: PolylinePoint) =>
				this.normalizePoint(p),
			);
			const trimmed = trimPolylineEnd(npts, normTrim);

			for (let i = 0; i < trimmed.length - 1; i++) {
				offset = writeSegmentQuad(
					buf,
					offset,
					trimmed[i],
					trimmed[i + 1],
					r,
					g,
					b,
					a,
				);
			}

			offset = writeArrowVertices(buf, offset, npts, r, g, b, a, 1 / this.bboxRange);
		});

		const gl = this.gl;
		gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
		gl.bufferData(gl.ARRAY_BUFFER, buf, gl.DYNAMIC_DRAW);
		this.vertexCount = offset / FLOATS_PER_VERTEX;
		this.dirty = false;
	}

	render() {
		if (this.dirty) {
			this.rebuildBuffer();
		}

		if (this.vertexCount === 0) return;

		const gl = this.gl;
		const params = this.sigma.getRenderParams();

		gl.clear(gl.COLOR_BUFFER_BIT);
		gl.enable(gl.BLEND);
		gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

		gl.useProgram(this.program);

		gl.uniformMatrix3fv(this.uMatrix, false, params.matrix);
		gl.uniform1f(this.uThickness, 0.5 * (window.devicePixelRatio || 1));
		gl.uniform2f(this.uResolution, this.canvas.width, this.canvas.height);

		gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
		const stride = FLOATS_PER_VERTEX * 4;

		gl.enableVertexAttribArray(this.aPosition);
		gl.vertexAttribPointer(this.aPosition, 2, gl.FLOAT, false, stride, 0);

		gl.enableVertexAttribArray(this.aNormal);
		gl.vertexAttribPointer(this.aNormal, 2, gl.FLOAT, false, stride, 8);

		gl.enableVertexAttribArray(this.aColor);
		gl.vertexAttribPointer(this.aColor, 4, gl.FLOAT, false, stride, 16);

		gl.drawArrays(gl.TRIANGLES, 0, this.vertexCount);
	}

	dispose() {
		this.sigma.off("afterRender", this.boundRender);
		this.resizeObserver.disconnect();
		this.gl.deleteBuffer(this.vbo);
		this.gl.deleteProgram(this.program);
		this.canvas.remove();
	}
}
