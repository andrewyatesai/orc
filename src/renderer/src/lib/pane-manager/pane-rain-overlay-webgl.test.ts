import { describe, expect, it, vi } from 'vitest'

import { WebGlRainQuadRenderer } from './pane-rain-overlay-webgl'

describe('WebGlRainQuadRenderer.dispose', () => {
  it('deletes owned objects and explicitly releases the browser context slot', () => {
    const noop = vi.fn()
    const loseContext = vi.fn()
    const deleteTexture = vi.fn()
    const deleteBuffer = vi.fn()
    const deleteVertexArray = vi.fn()
    const deleteProgram = vi.fn()
    const gl = new Proxy(
      {
        createShader: vi.fn(() => ({})),
        getShaderParameter: vi.fn(() => true),
        getShaderInfoLog: vi.fn(() => null),
        createProgram: vi.fn(() => ({})),
        getProgramParameter: vi.fn(() => true),
        getProgramInfoLog: vi.fn(() => null),
        createVertexArray: vi.fn(() => ({})),
        createBuffer: vi.fn(() => ({})),
        createTexture: vi.fn(() => ({})),
        getUniformLocation: vi.fn(() => ({})),
        deleteTexture,
        deleteBuffer,
        deleteVertexArray,
        deleteProgram,
        getExtension: vi.fn(() => ({ loseContext }))
      },
      {
        get(target, property) {
          if (property in target) {
            return target[property as keyof typeof target]
          }
          return typeof property === 'string' && property === property.toUpperCase() ? 1 : noop
        }
      }
    ) as unknown as WebGL2RenderingContext
    const removeEventListener = vi.fn()
    const canvas = {
      width: 320,
      height: 200,
      getContext: vi.fn(() => gl),
      addEventListener: vi.fn(),
      removeEventListener
    } as unknown as HTMLCanvasElement
    const renderer = new WebGlRainQuadRenderer(canvas)

    renderer.dispose()

    expect(deleteTexture).toHaveBeenCalledOnce()
    expect(deleteBuffer).toHaveBeenCalledOnce()
    expect(deleteVertexArray).toHaveBeenCalledOnce()
    expect(deleteProgram).toHaveBeenCalledOnce()
    expect(removeEventListener).toHaveBeenCalledWith('webglcontextlost', expect.any(Function))
    expect(loseContext).toHaveBeenCalledOnce()
  })
})
