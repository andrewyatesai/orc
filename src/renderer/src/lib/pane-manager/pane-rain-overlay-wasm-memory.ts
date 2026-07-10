export function borrowWasmU32(
  memory: WebAssembly.Memory,
  pointer: number,
  words: number
): Uint32Array {
  if (
    !Number.isSafeInteger(pointer) ||
    pointer < 0 ||
    pointer % 4 !== 0 ||
    !Number.isSafeInteger(words) ||
    words < 0
  ) {
    throw new Error('aterm returned an invalid u32 memory view')
  }
  const end = pointer + words * Uint32Array.BYTES_PER_ELEMENT
  if (!Number.isSafeInteger(end) || end > memory.buffer.byteLength) {
    throw new Error('aterm u32 memory view exceeds wasm memory')
  }
  return new Uint32Array(memory.buffer, pointer, words)
}

export function borrowWasmU8(
  memory: WebAssembly.Memory,
  pointer: number,
  bytes: number
): Uint8Array {
  if (!Number.isSafeInteger(pointer) || pointer < 0 || !Number.isSafeInteger(bytes) || bytes < 0) {
    throw new Error('aterm returned an invalid byte memory view')
  }
  const end = pointer + bytes
  if (!Number.isSafeInteger(end) || end > memory.buffer.byteLength) {
    throw new Error('aterm byte memory view exceeds wasm memory')
  }
  return new Uint8Array(memory.buffer, pointer, bytes)
}
