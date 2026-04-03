import { NodeProgram } from "sigma/rendering";
import type { ProgramInfo } from "sigma/rendering/utils";
import type { NodeDisplayData, RenderParams } from "sigma/types";
import { floatColor } from "sigma/utils";

const FLOAT = WebGLRenderingContext.FLOAT;
const UNSIGNED_BYTE = WebGLRenderingContext.UNSIGNED_BYTE;

const VERTEX_SHADER_SOURCE = /*glsl*/ `
attribute vec2 a_position;
attribute float a_size;
attribute float a_width;
attribute float a_height;
attribute vec4 a_color;
attribute vec4 a_borderColor;
attribute vec4 a_id;
attribute vec2 a_corner;

uniform mat3 u_matrix;
uniform float u_sizeRatio;
uniform float u_correctionRatio;

varying vec4 v_color;
varying vec4 v_borderColor;
varying vec2 v_halfSize;
varying vec2 v_fragOffset;

void main() {
  float w = a_width / u_sizeRatio;
  float h = a_height / u_sizeRatio;
  vec2 halfSize = vec2(w, h) * 0.5;
  float border = 1.0 * u_correctionRatio;
  vec2 offset = a_corner * (halfSize + border);

  vec3 projected = u_matrix * vec3(a_position, 1.0);
  gl_Position = vec4(
    projected.xy + offset * projected.z / u_correctionRatio,
    0.0,
    1.0
  );

  v_color = a_color;
  v_borderColor = a_borderColor;
  v_halfSize = halfSize;
  v_fragOffset = a_corner * (halfSize + border);
}
`;

const FRAGMENT_SHADER_SOURCE = /*glsl*/ `
precision mediump float;

varying vec4 v_color;
varying vec4 v_borderColor;
varying vec2 v_halfSize;
varying vec2 v_fragOffset;

void main() {
  vec2 absOff = abs(v_fragOffset);
  float dx = absOff.x - v_halfSize.x;
  float dy = absOff.y - v_halfSize.y;

  if (dx > 1.0 || dy > 1.0) {
    discard;
  }

  if (dx > 0.0 || dy > 0.0) {
    gl_FragColor = v_borderColor;
  } else {
    gl_FragColor = v_color;
  }
}
`;

const DEFAULT_BORDER_COLOR = "#d1d5db";

const UNIFORMS = ["u_sizeRatio", "u_correctionRatio", "u_matrix"] as const;

export default class NodeRectangleProgram extends NodeProgram<
	(typeof UNIFORMS)[number]
> {
	drawLabel = undefined;
	drawHover = undefined;

	getDefinition() {
		return {
			VERTICES: 6,
			VERTEX_SHADER_SOURCE,
			FRAGMENT_SHADER_SOURCE,
			METHOD: WebGLRenderingContext.TRIANGLES as number,
			UNIFORMS,
			ATTRIBUTES: [
				{ name: "a_position", size: 2, type: FLOAT },
				{ name: "a_size", size: 1, type: FLOAT },
				{ name: "a_width", size: 1, type: FLOAT },
				{ name: "a_height", size: 1, type: FLOAT },
				{
					name: "a_color",
					size: 4,
					type: UNSIGNED_BYTE,
					normalized: true,
				},
				{
					name: "a_borderColor",
					size: 4,
					type: UNSIGNED_BYTE,
					normalized: true,
				},
				{
					name: "a_id",
					size: 4,
					type: UNSIGNED_BYTE,
					normalized: true,
				},
			],
			CONSTANT_ATTRIBUTES: [{ name: "a_corner", size: 2, type: FLOAT }],
			CONSTANT_DATA: [
				[-1, -1],
				[1, -1],
				[-1, 1],
				[-1, 1],
				[1, -1],
				[1, 1],
			],
		};
	}

	processVisibleItem(
		nodeIndex: number,
		startIndex: number,
		data: NodeDisplayData,
	) {
		const color = floatColor(data.color);
		const borderColor = floatColor(
			(data as NodeDisplayData & { borderColor?: string }).borderColor ??
				DEFAULT_BORDER_COLOR,
		);
		const w = (data as NodeDisplayData & { width?: number }).width ?? data.size;
		const h =
			(data as NodeDisplayData & { height?: number }).height ?? data.size;

		this.array[startIndex++] = data.x;
		this.array[startIndex++] = data.y;
		this.array[startIndex++] = data.size;
		this.array[startIndex++] = w;
		this.array[startIndex++] = h;
		this.array[startIndex++] = color;
		this.array[startIndex++] = borderColor;
		this.array[startIndex++] = nodeIndex;
	}

	setUniforms(
		params: RenderParams,
		{ gl, uniformLocations }: ProgramInfo<(typeof UNIFORMS)[number]>,
	) {
		const { u_sizeRatio, u_correctionRatio, u_matrix } = uniformLocations;
		gl.uniform1f(u_sizeRatio, params.sizeRatio);
		gl.uniform1f(u_correctionRatio, params.correctionRatio);
		gl.uniformMatrix3fv(u_matrix, false, params.matrix);
	}
}
