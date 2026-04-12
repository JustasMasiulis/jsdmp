import type { CfgNode, CfgTextSyntaxKind } from "../lib/disassemblyGraph";
import {
	CARD_PADDING_X,
	CARD_PADDING_Y,
	ESTIMATED_CHAR_WIDTH,
	ESTIMATED_LINE_HEIGHT,
} from "../lib/disassemblyGraph";
import { CfgCanvasLayer } from "./cfgCanvasLayer";
import type { CfgGraphRenderer } from "./cfgGraphRenderer";
import type { CfgRenderGraph } from "./cfgRenderGraph";
import { createFontAtlas, type FontAtlas } from "./fontAtlas";
import { compileSimpleProgram } from "./utils.";

const VERTEX_SHADER = `#version 300 es
in vec2 a_position;
in vec2 a_texcoord;
in vec4 a_color;

uniform mat3 u_matrix;

out vec2 v_texcoord;
out vec4 v_color;

void main() {
    vec3 pos = u_matrix * vec3(a_position, 1.0);
    gl_Position = vec4(pos.xy, 0.0, 1.0);
    v_texcoord = a_texcoord;
    v_color = a_color;
}
`;

const FRAGMENT_SHADER = `#version 300 es
precision mediump float;
uniform sampler2D u_atlas;
uniform vec3 u_fillColor;
uniform float u_borderWidth;
in vec2 v_texcoord;
in vec4 v_color;
out vec4 fragColor;

void main() {
    if (v_texcoord.x < -1.5) {
        float u = v_texcoord.x + 3.0;
        float v = v_texcoord.y;
        float bu = u_borderWidth * fwidth(u);
        float bv = u_borderWidth * fwidth(v);
        if (u < bu || u > 1.0 - bu || v < bv || v > 1.0 - bv)
            fragColor = v_color;
        else
            fragColor = vec4(u_fillColor, 1.0);
        return;
    }
    if (v_texcoord.x < 0.0) {
        fragColor = v_color;
        return;
    }
    float a = texture(u_atlas, v_texcoord).a;
    fragColor = vec4(v_color.rgb, v_color.a * a);
}
`;

const FLOATS_PER_QUAD = 48;
const CULL_INTERVAL_MS = 100;

const SYNTAX_COLORS: Record<CfgTextSyntaxKind, [number, number, number]> = {
	plain: [0.1, 0.1, 0.1],
	mnemonic: [0.21, 0.46, 0.99],
	number: [0.78, 0.26, 0.16],
};

const BLOCK_BG_R = 0.992156862745098;
const BLOCK_BG_G = 0.996078431372549;
const BLOCK_BG_B = 1;
const BORDER_R = 0.8705882352941176;
const BORDER_G = 0.8745098039215686;
const BORDER_B = 0.8784313725490196;
const SEL_BORDER_R = 0.21;
const SEL_BORDER_G = 0.46;
const SEL_BORDER_B = 0.99;
const HIGHLIGHT_R = 0.85;
const HIGHLIGHT_G = 0.88;
const HIGHLIGHT_B = 0.95;
const BORDER_WIDTH = 1;
const SELECTED_BORDER_COLOR = "#3575fe";

type NodeEntry = {
	id: string;
	x: number;
	y: number;
	w: number;
	h: number;
};

export class BlockTextRenderer extends CfgCanvasLayer {
	private readonly graph: CfgRenderGraph;
	private readonly nodesById: Map<string, CfgNode>;
	private readonly atlas: FontAtlas;
	private readonly program: WebGLProgram;
	private readonly vbo: WebGLBuffer | null;

	private readonly aPosition: number;
	private readonly aTexcoord: number;
	private readonly aColor: number;
	private readonly uMatrix: WebGLUniformLocation | null;
	private readonly uAtlas: WebGLUniformLocation | null;
	private readonly uFillColor: WebGLUniformLocation | null;
	private readonly uBorderWidth: WebGLUniformLocation | null;

	private nodeEntries: NodeEntry[] = [];
	private vertexCount = 0;
	private lastCullTime = 0;
	private visibleIds = new Set<string>();
	private buf: Float32Array = new Float32Array(0);
	private bufCapacity = 0;

	private highlightedTerm: string | null = null;
	private highlightedLineAddr: string | null = null;

	constructor(
		renderer: CfgGraphRenderer,
		graph: CfgRenderGraph,
		nodesById: Map<string, CfgNode>,
	) {
		super(renderer, "6", false);
		this.graph = graph;
		this.nodesById = nodesById;

		const gl = this.gl;
		this.program = compileSimpleProgram(gl, VERTEX_SHADER, FRAGMENT_SHADER);
		this.aPosition = gl.getAttribLocation(this.program, "a_position");
		this.aTexcoord = gl.getAttribLocation(this.program, "a_texcoord");
		this.aColor = gl.getAttribLocation(this.program, "a_color");
		this.uMatrix = gl.getUniformLocation(this.program, "u_matrix");
		this.uAtlas = gl.getUniformLocation(this.program, "u_atlas");
		this.uFillColor = gl.getUniformLocation(this.program, "u_fillColor");
		this.uBorderWidth = gl.getUniformLocation(this.program, "u_borderWidth");

		gl.useProgram(this.program);
		gl.uniform3f(this.uFillColor, BLOCK_BG_R, BLOCK_BG_G, BLOCK_BG_B);
		gl.uniform1f(this.uBorderWidth, BORDER_WIDTH);

		this.vbo = gl.createBuffer();
		this.atlas = createFontAtlas(gl);

		this.buildNodeIndex();
	}

	highlightTerm(term: string | null): void {
		if (this.highlightedTerm === term) return;
		this.highlightedTerm = term;
		this.dirty = true;
		this.onRender();
	}

	highlightLineAddress(hexAddress: string | null): void {
		if (this.highlightedLineAddr === hexAddress) return;
		this.highlightedLineAddr = hexAddress;
		this.dirty = true;
		this.onRender();
	}

	markDirtyAndRender(): void {
		this.dirty = true;
		this.lastCullTime = 0;
		this.onRender();
	}

	dispose(): void {
		this.atlas.dispose(this.gl);
		this.gl.deleteBuffer(this.vbo);
		this.gl.deleteProgram(this.program);
		super.dispose();
	}

	private buildNodeIndex(): void {
		for (const node of this.graph.nodes) {
			this.nodeEntries.push({
				id: node.id,
				x: node.x,
				y: node.y,
				w: node.width,
				h: node.height,
			});
		}
	}

	protected onRender(): void {
		const now = performance.now();
		if (now - this.lastCullTime >= CULL_INTERVAL_MS) {
			this.lastCullTime = now;
			this.updateCull();
		}
		this.render();
	}

	private updateCull(): void {
		this.updateBBox();
		const { width: vpW, height: vpH } = this.renderer.getDimensions();
		if (vpW <= 0 || vpH <= 0) return;

		const corner1 = this.renderer.viewportToGraph({ x: -200, y: -200 });
		const corner2 = this.renderer.viewportToGraph({
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
			totalQuads += 1;
			const cfgNode = this.nodesById.get(node.id);
			if (!cfgNode) continue;
			for (const line of cfgNode.lines) {
				totalQuads += line.text.length;
			}
			if (this.highlightedTerm || this.highlightedLineAddr) {
				for (const line of cfgNode.lines) {
					if (
						this.highlightedLineAddr &&
						line.segments[0]?.text === this.highlightedLineAddr
					) {
						totalQuads++;
					}
					if (this.highlightedTerm) {
						for (const seg of line.segments) {
							if (seg.term === this.highlightedTerm)
								totalQuads += seg.text.length;
						}
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

			const renderNode = this.graph.nodeMap.get(node.id);
			const isSelected = renderNode?.borderColor === SELECTED_BORDER_COLOR;
			const br = isSelected ? SEL_BORDER_R : BORDER_R;
			const bg = isSelected ? SEL_BORDER_G : BORDER_G;
			const bb = isSelected ? SEL_BORDER_B : BORDER_B;

			o = writeQuad(buf, o, nx0, ny0, nw, nh, -3, 0, -2, 1, br, bg, bb);

			const baseGX = node.x + paddingX;
			const baseGY = node.y - paddingY;

			for (let li = 0; li < cfgNode.lines.length; li++) {
				const line = cfgNode.lines[li];
				const lineGY = baseGY - li * charH;
				const lineNY = 0.5 + (lineGY - cy) * inv;
				let charIdx = 0;

				if (
					this.highlightedLineAddr &&
					line.segments[0]?.text === this.highlightedLineAddr
				) {
					o = writeQuad(
						buf,
						o,
						nx0 + nBorderW,
						lineNY,
						nw - 2 * nBorderW,
						nCharH,
						-1,
						-1,
						-1,
						-1,
						HIGHLIGHT_R,
						HIGHLIGHT_G,
						HIGHLIGHT_B,
					);
				}

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
								o = writeQuad(
									buf,
									o,
									charNX,
									lineNY,
									nCharW,
									nCharH,
									-1,
									-1,
									-1,
									-1,
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
		gl.bufferData(gl.ARRAY_BUFFER, buf, gl.DYNAMIC_DRAW, 0, o);
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

		const params = this.renderer.getRenderParams();

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

function writeQuad(
	buf: Float32Array,
	o: number,
	x: number,
	y: number,
	w: number,
	h: number,
	u0: number,
	v0: number,
	u1: number,
	v1: number,
	r: number,
	g: number,
	b: number,
): number {
	const x1 = x + w;
	const y1 = y - h;
	buf[o++] = x;
	buf[o++] = y;
	buf[o++] = u0;
	buf[o++] = v0;
	buf[o++] = r;
	buf[o++] = g;
	buf[o++] = b;
	buf[o++] = 1;
	buf[o++] = x1;
	buf[o++] = y;
	buf[o++] = u1;
	buf[o++] = v0;
	buf[o++] = r;
	buf[o++] = g;
	buf[o++] = b;
	buf[o++] = 1;
	buf[o++] = x;
	buf[o++] = y1;
	buf[o++] = u0;
	buf[o++] = v1;
	buf[o++] = r;
	buf[o++] = g;
	buf[o++] = b;
	buf[o++] = 1;
	buf[o++] = x;
	buf[o++] = y1;
	buf[o++] = u0;
	buf[o++] = v1;
	buf[o++] = r;
	buf[o++] = g;
	buf[o++] = b;
	buf[o++] = 1;
	buf[o++] = x1;
	buf[o++] = y;
	buf[o++] = u1;
	buf[o++] = v0;
	buf[o++] = r;
	buf[o++] = g;
	buf[o++] = b;
	buf[o++] = 1;
	buf[o++] = x1;
	buf[o++] = y1;
	buf[o++] = u1;
	buf[o++] = v1;
	buf[o++] = r;
	buf[o++] = g;
	buf[o++] = b;
	buf[o++] = 1;
	return o;
}
