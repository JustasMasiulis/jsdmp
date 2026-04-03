import type Graph from "graphology";
import type Sigma from "sigma";
import type { CfgNode, CfgTextSyntaxKind } from "../lib/disassemblyGraph";
import {
	CARD_PADDING_X,
	CARD_PADDING_Y,
	ESTIMATED_CHAR_WIDTH,
	ESTIMATED_LINE_HEIGHT,
} from "../lib/disassemblyGraph";
import { createFontAtlas, type FontAtlas } from "./fontAtlas";

const VERTEX_SHADER = `
attribute vec2 a_position;
attribute vec2 a_texcoord;
attribute vec4 a_color;

uniform mat3 u_matrix;

varying vec2 v_texcoord;
varying vec4 v_color;

void main() {
    vec3 pos = u_matrix * vec3(a_position, 1.0);
    gl_Position = vec4(pos.xy, 0.0, 1.0);
    v_texcoord = a_texcoord;
    v_color = a_color;
}
`;

const FRAGMENT_SHADER = `
precision mediump float;
uniform sampler2D u_atlas;
varying vec2 v_texcoord;
varying vec4 v_color;

void main() {
    if (v_texcoord.x < 0.0) {
        gl_FragColor = v_color;
        return;
    }
    float a = texture2D(u_atlas, v_texcoord).a;
    if (a < 0.01) discard;
    gl_FragColor = vec4(v_color.rgb, v_color.a * a);
}
`;

const FLOATS_PER_QUAD = 48;
const CULL_INTERVAL_MS = 100;

const SYNTAX_COLORS: Record<CfgTextSyntaxKind, [number, number, number]> = {
	plain: [0.1, 0.1, 0.1],
	mnemonic: [0.21, 0.46, 0.99],
	number: [0.78, 0.26, 0.16],
};

const BLOCK_BG_R = 0.973;
const BLOCK_BG_G = 0.976;
const BLOCK_BG_B = 0.98;
const BORDER_R = 0.61;
const BORDER_G = 0.64;
const BORDER_B = 0.68;
const SEL_BORDER_R = 0.21;
const SEL_BORDER_G = 0.46;
const SEL_BORDER_B = 0.99;
const HIGHLIGHT_R = 0.85;
const HIGHLIGHT_G = 0.88;
const HIGHLIGHT_B = 0.95;
const BORDER_WIDTH = 1;

type NodeEntry = {
	id: string;
	x: number;
	y: number;
	w: number;
	h: number;
};

function compileShader(
	gl: WebGL2RenderingContext,
	type: number,
	source: string,
): WebGLShader {
	const shader = gl.createShader(type)!;
	gl.shaderSource(shader, source);
	gl.compileShader(shader);
	if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
		const info = gl.getShaderInfoLog(shader);
		gl.deleteShader(shader);
		throw new Error(`Shader compile: ${info}`);
	}
	return shader;
}

function linkProgram(
	gl: WebGL2RenderingContext,
	vs: string,
	fs: string,
): WebGLProgram {
	const v = compileShader(gl, gl.VERTEX_SHADER, vs);
	const f = compileShader(gl, gl.FRAGMENT_SHADER, fs);
	const p = gl.createProgram()!;
	gl.attachShader(p, v);
	gl.attachShader(p, f);
	gl.linkProgram(p);
	if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
		const info = gl.getProgramInfoLog(p);
		gl.deleteProgram(p);
		throw new Error(`Program link: ${info}`);
	}
	gl.deleteShader(v);
	gl.deleteShader(f);
	return p;
}

export class BlockTextRenderer {
	private readonly sigma: Sigma;
	private readonly graph: Graph;
	private readonly nodesById: Map<string, CfgNode>;
	private readonly atlas: FontAtlas;
	private readonly canvas: HTMLCanvasElement;
	private readonly gl: WebGL2RenderingContext;
	private readonly program: WebGLProgram;
	private readonly vbo: WebGLBuffer;

	private readonly aPosition: number;
	private readonly aTexcoord: number;
	private readonly aColor: number;
	private readonly uMatrix: WebGLUniformLocation;
	private readonly uAtlas: WebGLUniformLocation;

	private readonly boundRender: () => void;
	private readonly resizeObserver: ResizeObserver;

	private nodeEntries: NodeEntry[] = [];
	private vertexCount = 0;
	private dirty = true;
	private lastCullTime = 0;
	private visibleIds = new Set<string>();
	private buf: Float32Array = new Float32Array(0);
	private bufCapacity = 0;

	private bboxCenterX = 0;
	private bboxCenterY = 0;
	private bboxRange = 1;
	private invBBoxRange = 1;

	private highlightedTerm: string | null = null;

	constructor(sigma: Sigma, graph: Graph, nodesById: Map<string, CfgNode>) {
		this.sigma = sigma;
		this.graph = graph;
		this.nodesById = nodesById;

		const container = sigma.getContainer();
		this.canvas = document.createElement("canvas");
		this.canvas.style.position = "absolute";
		this.canvas.style.inset = "0";
		this.canvas.style.pointerEvents = "none";
		this.canvas.style.zIndex = "6";
		container.appendChild(this.canvas);

		const gl = this.canvas.getContext("webgl2", {
			alpha: true,
			premultipliedAlpha: false,
			antialias: false,
		})!;
		this.gl = gl;

		this.program = linkProgram(gl, VERTEX_SHADER, FRAGMENT_SHADER);
		this.aPosition = gl.getAttribLocation(this.program, "a_position");
		this.aTexcoord = gl.getAttribLocation(this.program, "a_texcoord");
		this.aColor = gl.getAttribLocation(this.program, "a_color");
		this.uMatrix = gl.getUniformLocation(this.program, "u_matrix")!;
		this.uAtlas = gl.getUniformLocation(this.program, "u_atlas")!;

		this.vbo = gl.createBuffer()!;
		this.atlas = createFontAtlas(gl);

		this.buildNodeIndex();

		this.resizeObserver = new ResizeObserver(() => {
			if (this.syncCanvasSize()) {
				this.sigma.refresh();
			}
		});
		this.resizeObserver.observe(container);
		this.syncCanvasSize();

		this.boundRender = () => this.onFrame();
		sigma.on("afterRender", this.boundRender);
	}

	highlightTerm(term: string | null): void {
		if (this.highlightedTerm === term) return;
		this.highlightedTerm = term;
		this.dirty = true;
		this.onFrame();
	}

	markDirtyAndRender(): void {
		this.dirty = true;
		this.onFrame();
	}

	dispose(): void {
		this.sigma.off("afterRender", this.boundRender);
		this.resizeObserver.disconnect();
		this.atlas.dispose(this.gl);
		this.gl.deleteBuffer(this.vbo);
		this.gl.deleteProgram(this.program);
		this.canvas.remove();
	}

	private buildNodeIndex(): void {
		this.graph.forEachNode((nodeId) => {
			const x = this.graph.getNodeAttribute(nodeId, "x") as number;
			const sigmaY = this.graph.getNodeAttribute(nodeId, "y") as number;
			const w = (this.graph.getNodeAttribute(nodeId, "width") as number) ?? 0;
			const h = (this.graph.getNodeAttribute(nodeId, "height") as number) ?? 0;
			this.nodeEntries.push({ id: nodeId, x, y: sigmaY, w, h });
		});
	}

	private syncCanvasSize(): boolean {
		const container = this.sigma.getContainer();
		const w = container.clientWidth;
		const h = container.clientHeight;
		const dpr = window.devicePixelRatio || 1;
		const targetW = Math.round(w * dpr);
		const targetH = Math.round(h * dpr);
		if (this.canvas.width === targetW && this.canvas.height === targetH) {
			return false;
		}
		this.canvas.width = targetW;
		this.canvas.height = targetH;
		this.canvas.style.width = `${w}px`;
		this.canvas.style.height = `${h}px`;
		this.gl.viewport(0, 0, targetW, targetH);
		this.dirty = true;
		return true;
	}

	private updateBBox(): void {
		const bbox = this.sigma.getCustomBBox();
		if (!bbox) return;
		const prevRange = this.bboxRange;
		this.bboxCenterX = (bbox.x[0] + bbox.x[1]) / 2;
		this.bboxCenterY = (bbox.y[0] + bbox.y[1]) / 2;
		this.bboxRange = Math.max(bbox.x[1] - bbox.x[0], bbox.y[1] - bbox.y[0], 1);
		this.invBBoxRange = 1 / this.bboxRange;
		if (this.bboxRange !== prevRange) {
			this.dirty = true;
		}
	}

	private onFrame(): void {
		const now = performance.now();
		if (now - this.lastCullTime >= CULL_INTERVAL_MS) {
			this.lastCullTime = now;
			this.updateCull();
		}
		this.render();
	}

	private updateCull(): void {
		this.updateBBox();
		const { width: vpW, height: vpH } = this.sigma.getDimensions();
		if (vpW <= 0 || vpH <= 0) return;

		const corner1 = this.sigma.viewportToGraph({ x: -200, y: -200 });
		const corner2 = this.sigma.viewportToGraph({
			x: vpW + 200,
			y: vpH + 200,
		});

		const cullMinX = Math.min(corner1.x, corner2.x);
		const cullMaxX = Math.max(corner1.x, corner2.x);
		const cullMinY = Math.min(corner1.y, corner2.y);
		const cullMaxY = Math.max(corner1.y, corner2.y);

		const nextVisible = new Set<string>();
		for (const node of this.nodeEntries) {
			if (
				node.x + node.w >= cullMinX &&
				node.x <= cullMaxX &&
				node.y >= cullMinY &&
				node.y - node.h <= cullMaxY
			) {
				nextVisible.add(node.id);
			}
		}

		if (
			nextVisible.size !== this.visibleIds.size ||
			![...nextVisible].every((id) => this.visibleIds.has(id))
		) {
			this.visibleIds = nextVisible;
			this.dirty = true;
		}
	}

	private ensureBuffer(quads: number): void {
		const needed = quads * FLOATS_PER_QUAD;
		if (needed <= this.bufCapacity) return;
		const cap = Math.max(needed, this.bufCapacity * 2, 65536);
		this.buf = new Float32Array(cap);
		this.bufCapacity = cap;
	}

	private rebuildBuffer(): void {
		this.updateBBox();

		const inv = this.invBBoxRange;
		const cx = this.bboxCenterX;
		const cy = this.bboxCenterY;
		const uvTable = this.atlas.uvTable;
		const firstChar = this.atlas.firstChar;
		const lastChar = this.atlas.lastChar;
		const fallbackIdx = this.atlas.fallbackIdx;

		const paddingX = CARD_PADDING_X / 2;
		const paddingY = CARD_PADDING_Y / 2;
		const charW = ESTIMATED_CHAR_WIDTH;
		const charH = ESTIMATED_LINE_HEIGHT;
		const nCharW = charW * inv;
		const nCharH = charH * inv;
		const nBorderW = BORDER_WIDTH * inv;

		let totalQuads = 0;
		for (const node of this.nodeEntries) {
			if (!this.visibleIds.has(node.id)) continue;
			totalQuads += 5;
			const cfgNode = this.nodesById.get(node.id);
			if (!cfgNode) continue;
			for (const line of cfgNode.lines) {
				totalQuads += line.text.length;
			}
			if (this.highlightedTerm) {
				for (const line of cfgNode.lines) {
					for (const seg of line.segments) {
						if (seg.term === this.highlightedTerm)
							totalQuads += seg.text.length;
					}
				}
			}
		}

		this.ensureBuffer(totalQuads + 64);
		const buf = this.buf;
		let o = 0;

		for (const node of this.nodeEntries) {
			if (!this.visibleIds.has(node.id)) continue;
			const cfgNode = this.nodesById.get(node.id);
			if (!cfgNode) continue;

			const nx0 = 0.5 + (node.x - cx) * inv;
			const ny0 = 0.5 + (node.y - cy) * inv;
			const nw = node.w * inv;
			const nh = node.h * inv;

			const isSelected =
				this.graph.getNodeAttribute(node.id, "borderColor") === "#3575fe";
			const br = isSelected ? SEL_BORDER_R : BORDER_R;
			const bg = isSelected ? SEL_BORDER_G : BORDER_G;
			const bb = isSelected ? SEL_BORDER_B : BORDER_B;

			o = solidQuad(
				buf,
				o,
				nx0,
				ny0,
				nw,
				nh,
				BLOCK_BG_R,
				BLOCK_BG_G,
				BLOCK_BG_B,
			);
			o = solidQuad(buf, o, nx0, ny0, nw, nBorderW, br, bg, bb);
			o = solidQuad(buf, o, nx0, ny0 - nh + nBorderW, nw, nBorderW, br, bg, bb);
			o = solidQuad(buf, o, nx0, ny0, nBorderW, nh, br, bg, bb);
			o = solidQuad(buf, o, nx0 + nw - nBorderW, ny0, nBorderW, nh, br, bg, bb);

			const baseGX = node.x + paddingX;
			const baseGY = node.y - paddingY;

			for (let li = 0; li < cfgNode.lines.length; li++) {
				const line = cfgNode.lines[li];
				const lineGY = baseGY - li * charH;
				const lineNY = 0.5 + (lineGY - cy) * inv;
				let charIdx = 0;

				const segs = line.segments.length > 0 ? line.segments : null;
				if (segs) {
					for (const seg of segs) {
						const colors = SYNTAX_COLORS[seg.syntaxKind];
						const cr = colors[0];
						const cg = colors[1];
						const cb = colors[2];
						const isHl =
							this.highlightedTerm !== null &&
							seg.term === this.highlightedTerm;

						for (let ci = 0; ci < seg.text.length; ci++) {
							const charNX = 0.5 + (baseGX + charIdx * charW - cx) * inv;

							if (isHl) {
								o = solidQuad(
									buf,
									o,
									charNX,
									lineNY,
									nCharW,
									nCharH,
									HIGHLIGHT_R,
									HIGHLIGHT_G,
									HIGHLIGHT_B,
								);
							}

							const code = seg.text.charCodeAt(ci);
							let uvIdx = (code - firstChar) * 4;
							if (uvIdx < 0 || code > lastChar) uvIdx = fallbackIdx;

							const x1 = charNX + nCharW;
							const y1 = lineNY - nCharH;
							const u0 = uvTable[uvIdx];
							const v0 = uvTable[uvIdx + 1];
							const u1 = uvTable[uvIdx + 2];
							const v1 = uvTable[uvIdx + 3];

							buf[o++] = charNX;
							buf[o++] = lineNY;
							buf[o++] = u0;
							buf[o++] = v0;
							buf[o++] = cr;
							buf[o++] = cg;
							buf[o++] = cb;
							buf[o++] = 1;
							buf[o++] = x1;
							buf[o++] = lineNY;
							buf[o++] = u1;
							buf[o++] = v0;
							buf[o++] = cr;
							buf[o++] = cg;
							buf[o++] = cb;
							buf[o++] = 1;
							buf[o++] = charNX;
							buf[o++] = y1;
							buf[o++] = u0;
							buf[o++] = v1;
							buf[o++] = cr;
							buf[o++] = cg;
							buf[o++] = cb;
							buf[o++] = 1;
							buf[o++] = charNX;
							buf[o++] = y1;
							buf[o++] = u0;
							buf[o++] = v1;
							buf[o++] = cr;
							buf[o++] = cg;
							buf[o++] = cb;
							buf[o++] = 1;
							buf[o++] = x1;
							buf[o++] = lineNY;
							buf[o++] = u1;
							buf[o++] = v0;
							buf[o++] = cr;
							buf[o++] = cg;
							buf[o++] = cb;
							buf[o++] = 1;
							buf[o++] = x1;
							buf[o++] = y1;
							buf[o++] = u1;
							buf[o++] = v1;
							buf[o++] = cr;
							buf[o++] = cg;
							buf[o++] = cb;
							buf[o++] = 1;

							charIdx++;
						}
					}
				} else {
					const text = line.text;
					for (let ci = 0; ci < text.length; ci++) {
						const charNX = 0.5 + (baseGX + ci * charW - cx) * inv;

						const code = text.charCodeAt(ci);
						let uvIdx = (code - firstChar) * 4;
						if (uvIdx < 0 || code > lastChar) uvIdx = fallbackIdx;

						const x1 = charNX + nCharW;
						const y1 = lineNY - nCharH;
						const u0 = uvTable[uvIdx];
						const v0 = uvTable[uvIdx + 1];
						const u1 = uvTable[uvIdx + 2];
						const v1 = uvTable[uvIdx + 3];

						buf[o++] = charNX;
						buf[o++] = lineNY;
						buf[o++] = u0;
						buf[o++] = v0;
						buf[o++] = 0.1;
						buf[o++] = 0.1;
						buf[o++] = 0.1;
						buf[o++] = 1;
						buf[o++] = x1;
						buf[o++] = lineNY;
						buf[o++] = u1;
						buf[o++] = v0;
						buf[o++] = 0.1;
						buf[o++] = 0.1;
						buf[o++] = 0.1;
						buf[o++] = 1;
						buf[o++] = charNX;
						buf[o++] = y1;
						buf[o++] = u0;
						buf[o++] = v1;
						buf[o++] = 0.1;
						buf[o++] = 0.1;
						buf[o++] = 0.1;
						buf[o++] = 1;
						buf[o++] = charNX;
						buf[o++] = y1;
						buf[o++] = u0;
						buf[o++] = v1;
						buf[o++] = 0.1;
						buf[o++] = 0.1;
						buf[o++] = 0.1;
						buf[o++] = 1;
						buf[o++] = x1;
						buf[o++] = lineNY;
						buf[o++] = u1;
						buf[o++] = v0;
						buf[o++] = 0.1;
						buf[o++] = 0.1;
						buf[o++] = 0.1;
						buf[o++] = 1;
						buf[o++] = x1;
						buf[o++] = y1;
						buf[o++] = u1;
						buf[o++] = v1;
						buf[o++] = 0.1;
						buf[o++] = 0.1;
						buf[o++] = 0.1;
						buf[o++] = 1;
					}
				}
			}
		}

		const gl = this.gl;
		gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
		gl.bufferData(gl.ARRAY_BUFFER, buf.subarray(0, o), gl.DYNAMIC_DRAW);
		this.vertexCount = o / 8;
		this.dirty = false;
	}

	private render(): void {
		if (this.dirty) {
			this.rebuildBuffer();
		}

		const gl = this.gl;
		gl.clearColor(0, 0, 0, 0);
		gl.clear(gl.COLOR_BUFFER_BIT);

		if (this.vertexCount === 0) return;

		const params = this.sigma.getRenderParams();

		gl.enable(gl.BLEND);
		gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

		gl.useProgram(this.program);
		gl.uniformMatrix3fv(this.uMatrix, false, params.matrix);

		gl.activeTexture(gl.TEXTURE0);
		gl.bindTexture(gl.TEXTURE_2D, this.atlas.texture);
		gl.uniform1i(this.uAtlas, 0);

		gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
		const stride = 32;

		gl.enableVertexAttribArray(this.aPosition);
		gl.vertexAttribPointer(this.aPosition, 2, gl.FLOAT, false, stride, 0);

		gl.enableVertexAttribArray(this.aTexcoord);
		gl.vertexAttribPointer(this.aTexcoord, 2, gl.FLOAT, false, stride, 8);

		gl.enableVertexAttribArray(this.aColor);
		gl.vertexAttribPointer(this.aColor, 4, gl.FLOAT, false, stride, 16);

		gl.drawArrays(gl.TRIANGLES, 0, this.vertexCount);
	}
}

function solidQuad(
	buf: Float32Array,
	o: number,
	x: number,
	y: number,
	w: number,
	h: number,
	r: number,
	g: number,
	b: number,
): number {
	const x1 = x + w;
	const y1 = y - h;
	buf[o++] = x;
	buf[o++] = y;
	buf[o++] = -1;
	buf[o++] = -1;
	buf[o++] = r;
	buf[o++] = g;
	buf[o++] = b;
	buf[o++] = 1;
	buf[o++] = x1;
	buf[o++] = y;
	buf[o++] = -1;
	buf[o++] = -1;
	buf[o++] = r;
	buf[o++] = g;
	buf[o++] = b;
	buf[o++] = 1;
	buf[o++] = x;
	buf[o++] = y1;
	buf[o++] = -1;
	buf[o++] = -1;
	buf[o++] = r;
	buf[o++] = g;
	buf[o++] = b;
	buf[o++] = 1;
	buf[o++] = x;
	buf[o++] = y1;
	buf[o++] = -1;
	buf[o++] = -1;
	buf[o++] = r;
	buf[o++] = g;
	buf[o++] = b;
	buf[o++] = 1;
	buf[o++] = x1;
	buf[o++] = y;
	buf[o++] = -1;
	buf[o++] = -1;
	buf[o++] = r;
	buf[o++] = g;
	buf[o++] = b;
	buf[o++] = 1;
	buf[o++] = x1;
	buf[o++] = y1;
	buf[o++] = -1;
	buf[o++] = -1;
	buf[o++] = r;
	buf[o++] = g;
	buf[o++] = b;
	buf[o++] = 1;
	return o;
}
