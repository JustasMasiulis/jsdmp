export function attachShader(
	gl: WebGL2RenderingContext,
	program: WebGLProgram,
	type: number,
	source: string,
): void {
	const shader = gl.createShader(type);
	if (!shader) throw new Error(`Failed to create shader type ${type}`);

	gl.shaderSource(shader, source);
	gl.compileShader(shader);

	const ok = gl.getShaderParameter(shader, gl.COMPILE_STATUS);
	if (ok) {
		gl.attachShader(program, shader);
	}

	gl.deleteShader(shader);

	if (!ok) {
		throw new Error(`shader compile (${type}): ${gl.getShaderInfoLog(shader)}`);
	}
}

export function linkProgram(
	gl: WebGL2RenderingContext,
	program: WebGLProgram,
): void {
	gl.linkProgram(program);
	if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
		const info = gl.getProgramInfoLog(program);
		gl.deleteProgram(program);
		throw new Error(`program link: ${info}`);
	}
}

export function createProgram(gl: WebGL2RenderingContext): WebGLProgram {
	const program = gl.createProgram();
	if (!program) throw new Error("failed to create WebGL program");
	return program;
}

export function compileSimpleProgram(
	gl: WebGL2RenderingContext,
	vertexShaderSource: string,
	fragmentShaderSource: string,
): WebGLProgram {
	const program = createProgram(gl);
	attachShader(gl, program, gl.VERTEX_SHADER, vertexShaderSource);
	attachShader(gl, program, gl.FRAGMENT_SHADER, fragmentShaderSource);
	linkProgram(gl, program);
	return program;
}
