const ATLAS_COLS = 16;
const ATLAS_ROWS = 6;
const FIRST_CHAR = 32;
const LAST_CHAR = 126;
const RENDER_FONT_SIZE = 32;
const FONT_FAMILY =
	"ui-monospace, 'Cascadia Code', 'Source Code Pro', Menlo, Consolas, 'DejaVu Sans Mono', monospace";

export type FontAtlas = {
	texture: WebGLTexture;
	cellWidth: number;
	cellHeight: number;
	atlasWidth: number;
	atlasHeight: number;
	getUV(charCode: number): { u0: number; v0: number; u1: number; v1: number };
	dispose(gl: WebGL2RenderingContext): void;
};

export function createFontAtlas(gl: WebGL2RenderingContext): FontAtlas {
	const canvas = document.createElement("canvas");
	const ctx = canvas.getContext("2d")!;

	ctx.font = `${RENDER_FONT_SIZE}px ${FONT_FAMILY}`;
	const metrics = ctx.measureText("M");
	const cellWidth = Math.ceil(metrics.width) + 2;
	const cellHeight = Math.ceil(RENDER_FONT_SIZE * 1.5) + 2;

	const atlasWidth = ATLAS_COLS * cellWidth;
	const atlasHeight = ATLAS_ROWS * cellHeight;
	canvas.width = atlasWidth;
	canvas.height = atlasHeight;

	ctx.font = `${RENDER_FONT_SIZE}px ${FONT_FAMILY}`;
	ctx.textBaseline = "top";
	ctx.fillStyle = "#ffffff";

	for (let code = FIRST_CHAR; code <= LAST_CHAR; code++) {
		const idx = code - FIRST_CHAR;
		const col = idx % ATLAS_COLS;
		const row = Math.floor(idx / ATLAS_COLS);
		const x = col * cellWidth + 1;
		const y = row * cellHeight + 1;
		ctx.fillText(String.fromCharCode(code), x, y);
	}

	const texture = gl.createTexture()!;
	gl.bindTexture(gl.TEXTURE_2D, texture);
	gl.texImage2D(
		gl.TEXTURE_2D,
		0,
		gl.RGBA,
		gl.RGBA,
		gl.UNSIGNED_BYTE,
		canvas,
	);
	gl.generateMipmap(gl.TEXTURE_2D);
	gl.texParameteri(
		gl.TEXTURE_2D,
		gl.TEXTURE_MIN_FILTER,
		gl.LINEAR_MIPMAP_LINEAR,
	);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
	gl.bindTexture(gl.TEXTURE_2D, null);

	const invW = 1 / atlasWidth;
	const invH = 1 / atlasHeight;
	const glyphW = cellWidth - 2;
	const glyphH = Math.round(glyphW * (15 / 7));

	const charCount = LAST_CHAR - FIRST_CHAR + 1;
	const uvTable = new Float32Array(charCount * 4);
	for (let i = 0; i < charCount; i++) {
		const col = i % ATLAS_COLS;
		const row = (i / ATLAS_COLS) | 0;
		const px = col * cellWidth + 1;
		const py = row * cellHeight + 1;
		uvTable[i * 4] = px * invW;
		uvTable[i * 4 + 1] = py * invH;
		uvTable[i * 4 + 2] = (px + glyphW) * invW;
		uvTable[i * 4 + 3] = (py + glyphH) * invH;
	}
	const fallbackIdx = ("?".charCodeAt(0) - FIRST_CHAR) * 4;

	return {
		texture,
		cellWidth,
		cellHeight,
		atlasWidth,
		atlasHeight,
		uvTable,
		firstChar: FIRST_CHAR,
		lastChar: LAST_CHAR,
		fallbackIdx,
		getUV(charCode: number) {
			let idx = (charCode - FIRST_CHAR) * 4;
			if (idx < 0 || idx >= charCount * 4) idx = fallbackIdx;
			return {
				u0: uvTable[idx],
				v0: uvTable[idx + 1],
				u1: uvTable[idx + 2],
				v1: uvTable[idx + 3],
			};
		},
		dispose(glCtx: WebGL2RenderingContext) {
			glCtx.deleteTexture(texture);
		},
	};
}
