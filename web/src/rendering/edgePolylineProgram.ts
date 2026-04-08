import { CfgCanvasLayer } from "./cfgCanvasLayer";
import type { CfgGraphRenderer } from "./cfgGraphRenderer";
import type { CfgRenderGraph } from "./cfgRenderGraph";
import { trimPolylineEnd } from "./cfgRenderGraph";
import { compileSimpleProgram } from "./utils.";

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

function parseColor(hex: string): [number, number, number, number] {
	const r = Number.parseInt(hex.slice(1, 3), 16) / 255;
	const g = Number.parseInt(hex.slice(3, 5), 16) / 255;
	const b = Number.parseInt(hex.slice(5, 7), 16) / 255;
	return [r, g, b, 1.0];
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

export class EdgePolylineRenderer extends CfgCanvasLayer {
	private graph: CfgRenderGraph;
	private program: WebGLProgram;
	private vbo: WebGLBuffer;
	private vertexCount = 0;

	private aPosition: number;
	private aNormal: number;
	private aColor: number;
	private uMatrix: WebGLUniformLocation;
	private uThickness: WebGLUniformLocation;
	private uResolution: WebGLUniformLocation;

	constructor(renderer: CfgGraphRenderer, graph: CfgRenderGraph) {
		super(renderer, "5", true);
		this.graph = graph;

		const gl = this.gl;
		this.program = compileSimpleProgram(gl, VERTEX_SHADER, FRAGMENT_SHADER);

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
	}

	markDirty() {
		this.dirty = true;
	}

	private normalizePoint(p: PolylinePoint): PolylinePoint {
		return {
			x: 0.5 + (p.x - this.bboxCenterX) / this.bboxRange,
			y: 0.5 + (p.y - this.bboxCenterY) / this.bboxRange,
		};
	}

	private rebuildBuffer() {
		this.updateBBox();

		let totalSegments = 0;
		let totalArrows = 0;

		for (const edge of this.graph.edges) {
			if (!edge.polylinePoints || edge.polylinePoints.length < 2) continue;
			totalSegments += Math.max(0, edge.polylinePoints.length - 2);
			totalArrows += 1;
		}

		const vertexCount = (totalSegments + totalArrows) * 6 + totalArrows * 3;
		const buf = new Float32Array(vertexCount * FLOATS_PER_VERTEX);
		let offset = 0;

		const normTrim = ARROW_TRIM / this.bboxRange;

		for (const edge of this.graph.edges) {
			if (!edge.polylinePoints || edge.polylinePoints.length < 2) continue;

			const [r, g, b, a] = parseColor(edge.color);

			const npts = edge.polylinePoints.map((p: PolylinePoint) =>
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

			offset = writeArrowVertices(
				buf,
				offset,
				npts,
				r,
				g,
				b,
				a,
				1 / this.bboxRange,
			);
		}

		const gl = this.gl;
		gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
		gl.bufferData(gl.ARRAY_BUFFER, buf, gl.DYNAMIC_DRAW);
		this.vertexCount = offset / FLOATS_PER_VERTEX;
		this.dirty = false;
	}

	protected onRender() {
		if (this.dirty) {
			this.rebuildBuffer();
		}

		if (this.vertexCount === 0) return;

		const gl = this.gl;
		const params = this.renderer.getRenderParams();

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
		this.gl.deleteBuffer(this.vbo);
		this.gl.deleteProgram(this.program);
		super.dispose();
	}
}
