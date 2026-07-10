import { ATERM_RAIN_QUAD_WORDS } from './pane-rain-overlay-wasm-types'

const VERTEX_SHADER = `#version 300 es
precision highp float;
precision highp int;
layout(location = 0) in uvec4 aRect;
layout(location = 1) in uvec4 aAtlas;
layout(location = 2) in uvec3 aMeta;
uniform vec2 uCanvas;
uniform vec2 uAtlasSize;
out vec2 vUv;
flat out vec4 vTint;

const vec2 CORNERS[6] = vec2[6](
  vec2(0.0, 0.0), vec2(1.0, 0.0), vec2(0.0, 1.0),
  vec2(0.0, 1.0), vec2(1.0, 0.0), vec2(1.0, 1.0)
);

void main() {
  vec2 corner = CORNERS[gl_VertexID];
  vec2 pixel = vec2(aRect.xy) + corner * vec2(aRect.zw);
  vec2 ndc = pixel / uCanvas * 2.0 - 1.0;
  gl_Position = vec4(ndc.x, -ndc.y, 0.0, 1.0);
  float sourceX = aMeta.z == 0u ? corner.x : 1.0 - corner.x;
  vUv = (vec2(aAtlas.xy) + vec2(sourceX, corner.y) * vec2(aAtlas.zw)) / uAtlasSize;
  vTint = vec4(
    float((aMeta.x >> 16u) & 255u) / 255.0,
    float((aMeta.x >> 8u) & 255u) / 255.0,
    float(aMeta.x & 255u) / 255.0,
    float(aMeta.y & 255u) / 255.0
  );
}`

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
uniform sampler2D uAtlas;
in vec2 vUv;
flat in vec4 vTint;
out vec4 outColor;

void main() {
  vec4 texel = texture(uAtlas, vUv);
  outColor = vec4(texel.rgb * vTint.rgb, texel.a * vTint.a);
}`

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)
  if (!shader) {
    throw new Error('unable to allocate aterm rain shader')
  }
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const reason = gl.getShaderInfoLog(shader) ?? 'unknown compile failure'
    gl.deleteShader(shader)
    throw new Error(`aterm rain shader compile failed: ${reason}`)
  }
  return shader
}

function createProgram(gl: WebGL2RenderingContext): WebGLProgram {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER)
  let fragment: WebGLShader
  try {
    fragment = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER)
  } catch (error) {
    gl.deleteShader(vertex)
    throw error
  }
  const program = gl.createProgram()
  if (!program) {
    gl.deleteShader(vertex)
    gl.deleteShader(fragment)
    throw new Error('unable to allocate aterm rain program')
  }
  gl.attachShader(program, vertex)
  gl.attachShader(program, fragment)
  gl.linkProgram(program)
  gl.deleteShader(vertex)
  gl.deleteShader(fragment)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const reason = gl.getProgramInfoLog(program) ?? 'unknown link failure'
    gl.deleteProgram(program)
    throw new Error(`aterm rain shader link failed: ${reason}`)
  }
  return program
}

function uniform(
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
  name: string
): WebGLUniformLocation {
  const location = gl.getUniformLocation(program, name)
  if (!location) {
    throw new Error(`aterm rain shader is missing ${name}`)
  }
  return location
}

export type RainQuadRenderer = {
  resize(): void
  uploadAtlas(bytes: Uint8Array, width: number, height: number): void
  draw(quads: Uint32Array): void
  clear(): void
  dispose(): void
}

export function releaseRainWebGlContext(gl: WebGL2RenderingContext): void {
  try {
    gl.getExtension('WEBGL_lose_context')?.loseContext()
  } catch {
    // Context release is best-effort after all owned GPU objects are deleted.
  }
}

/** Dedicated transparent WebGL2 compositor; the terminal remains xterm-owned. */
export class WebGlRainQuadRenderer implements RainQuadRenderer {
  private readonly gl: WebGL2RenderingContext
  private readonly program: WebGLProgram
  private readonly vao: WebGLVertexArrayObject
  private readonly instances: WebGLBuffer
  private readonly texture: WebGLTexture
  private readonly canvasUniform: WebGLUniformLocation
  private readonly atlasSizeUniform: WebGLUniformLocation
  private instanceCapacity = 0
  private atlasWidth = 0
  private atlasHeight = 0
  private disposed = false
  private contextLost = false

  constructor(private readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', {
      alpha: true,
      antialias: false,
      depth: false,
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
      stencil: false
    })
    if (!gl) {
      throw new Error('WebGL2 is unavailable for the aterm rain overlay')
    }
    this.gl = gl
    this.program = createProgram(gl)
    const vao = gl.createVertexArray()
    const instances = gl.createBuffer()
    const texture = gl.createTexture()
    if (!vao || !instances || !texture) {
      if (vao) {
        gl.deleteVertexArray(vao)
      }
      if (instances) {
        gl.deleteBuffer(instances)
      }
      if (texture) {
        gl.deleteTexture(texture)
      }
      gl.deleteProgram(this.program)
      throw new Error('unable to allocate aterm rain GPU state')
    }
    this.vao = vao
    this.instances = instances
    this.texture = texture
    try {
      this.canvasUniform = uniform(gl, this.program, 'uCanvas')
      this.atlasSizeUniform = uniform(gl, this.program, 'uAtlasSize')
      this.configurePipeline()
    } catch (error) {
      gl.deleteTexture(texture)
      gl.deleteBuffer(instances)
      gl.deleteVertexArray(vao)
      gl.deleteProgram(this.program)
      throw error
    }
    canvas.addEventListener('webglcontextlost', this.handleContextLost)
  }

  resize(): void {
    this.assertUsable()
    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height)
  }

  uploadAtlas(bytes: Uint8Array, width: number, height: number): void {
    this.assertUsable()
    if (width <= 0 || height <= 0 || bytes.length !== width * height * 4) {
      throw new Error(`invalid aterm rain atlas ${width}x${height} (${bytes.length} bytes)`)
    }
    const gl = this.gl
    if (
      width > gl.getParameter(gl.MAX_TEXTURE_SIZE) ||
      height > gl.getParameter(gl.MAX_TEXTURE_SIZE)
    ) {
      throw new Error(`aterm rain atlas ${width}x${height} exceeds the GPU texture limit`)
    }
    gl.bindTexture(gl.TEXTURE_2D, this.texture)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, bytes)
    this.atlasWidth = width
    this.atlasHeight = height
  }

  draw(quads: Uint32Array): void {
    this.assertUsable()
    if (quads.length % ATERM_RAIN_QUAD_WORDS !== 0) {
      throw new Error(`invalid aterm rain quad word count ${quads.length}`)
    }
    const gl = this.gl
    this.clear()
    if (quads.length === 0 || this.atlasWidth === 0 || this.atlasHeight === 0) {
      return
    }
    gl.useProgram(this.program)
    gl.bindVertexArray(this.vao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instances)
    const bytes = quads.byteLength
    if (bytes > this.instanceCapacity) {
      this.instanceCapacity = Math.max(1024, 2 ** Math.ceil(Math.log2(bytes)))
      gl.bufferData(gl.ARRAY_BUFFER, this.instanceCapacity, gl.DYNAMIC_DRAW)
    }
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, quads)
    gl.uniform2f(this.canvasUniform, this.canvas.width, this.canvas.height)
    gl.uniform2f(this.atlasSizeUniform, this.atlasWidth, this.atlasHeight)
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, quads.length / ATERM_RAIN_QUAD_WORDS)
  }

  clear(): void {
    if (this.disposed || this.contextLost) {
      return
    }
    const gl = this.gl
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
  }

  dispose(): void {
    if (this.disposed) {
      return
    }
    this.disposed = true
    this.canvas.removeEventListener('webglcontextlost', this.handleContextLost)
    if (this.contextLost) {
      return
    }
    const gl = this.gl
    gl.deleteTexture(this.texture)
    gl.deleteBuffer(this.instances)
    gl.deleteVertexArray(this.vao)
    gl.deleteProgram(this.program)
    // Chromium counts contexts, not just their objects. Explicitly release the
    // slot so hidden terminal tabs cannot evict a visible xterm renderer.
    releaseRainWebGlContext(gl)
  }

  private configurePipeline(): void {
    const gl = this.gl
    gl.useProgram(this.program)
    gl.bindVertexArray(this.vao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instances)
    const stride = ATERM_RAIN_QUAD_WORDS * Uint32Array.BYTES_PER_ELEMENT
    gl.enableVertexAttribArray(0)
    gl.vertexAttribIPointer(0, 4, gl.UNSIGNED_INT, stride, 1 * 4)
    gl.vertexAttribDivisor(0, 1)
    gl.enableVertexAttribArray(1)
    gl.vertexAttribIPointer(1, 4, gl.UNSIGNED_INT, stride, 5 * 4)
    gl.vertexAttribDivisor(1, 1)
    gl.enableVertexAttribArray(2)
    gl.vertexAttribIPointer(2, 3, gl.UNSIGNED_INT, stride, 9 * 4)
    gl.vertexAttribDivisor(2, 1)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.texture)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.uniform1i(uniform(gl, this.program, 'uAtlas'), 0)
    gl.disable(gl.DEPTH_TEST)
    gl.disable(gl.CULL_FACE)
    gl.disable(gl.SCISSOR_TEST)
    gl.enable(gl.BLEND)
    gl.blendEquation(gl.FUNC_ADD)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
    this.resize()
  }

  private assertUsable(): void {
    if (this.disposed || this.contextLost) {
      throw new Error('aterm rain WebGL context is unavailable')
    }
  }

  private readonly handleContextLost = (event: Event): void => {
    event.preventDefault()
    this.contextLost = true
    this.canvas.hidden = true
  }
}
