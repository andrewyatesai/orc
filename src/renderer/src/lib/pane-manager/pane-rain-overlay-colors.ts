import type { ITheme } from '@xterm/xterm'

import {
  RAIN_COLOR_MODE_MASK,
  RAIN_COLOR_PALETTE,
  RAIN_COLOR_RGB,
  RAIN_COLOR_VALUE_MASK
} from './pane-rain-overlay-types'

const DEFAULT_FOREGROUND = 0xffffff
const DEFAULT_BACKGROUND = 0x000000
const DEFAULT_ANSI = [
  0x2e3436, 0xcc0000, 0x4e9a06, 0xc4a000, 0x3465a4, 0x75507b, 0x06989a, 0xd3d7cf, 0x555753,
  0xef2929, 0x8ae234, 0xfce94f, 0x729fcf, 0xad7fa8, 0x34e2e2, 0xeeeeec
] as const
const ANSI_THEME_KEYS = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite'
] as const

export function parseRainCssColor(value: string | null | undefined, fallback: number): number {
  const source = value?.trim().toLowerCase()
  if (!source) {
    return fallback
  }
  if (/^#[0-9a-f]{3}$/.test(source)) {
    const r = source[1] ?? '0'
    const g = source[2] ?? '0'
    const b = source[3] ?? '0'
    return Number.parseInt(`${r}${r}${g}${g}${b}${b}`, 16)
  }
  if (/^#[0-9a-f]{6}$/.test(source)) {
    return Number.parseInt(source.slice(1), 16)
  }
  if (/^#[0-9a-f]{8}$/.test(source)) {
    return Number.parseInt(source.slice(1, 7), 16)
  }
  const rgb = source.match(/^rgba?\(\s*(\d+)\s*[, ]\s*(\d+)\s*[, ]\s*(\d+)/)
  if (!rgb) {
    return fallback
  }
  const channel = (index: number): number => Math.min(255, Number(rgb[index] ?? 0))
  return (channel(1) << 16) | (channel(2) << 8) | channel(3)
}

export class RainColorPalette {
  readonly values = new Uint32Array(256)
  foreground = DEFAULT_FOREGROUND
  background = DEFAULT_BACKGROUND
  private theme: ITheme | undefined
  private initialized = false

  update(theme: ITheme | undefined): boolean {
    if (this.initialized && theme === this.theme) {
      return false
    }
    this.initialized = true
    this.theme = theme
    this.foreground = parseRainCssColor(theme?.foreground, DEFAULT_FOREGROUND)
    this.background = parseRainCssColor(theme?.background, DEFAULT_BACKGROUND)
    for (let index = 0; index < 16; index += 1) {
      const key = ANSI_THEME_KEYS[index]
      this.values[index] = parseRainCssColor(key ? theme?.[key] : undefined, DEFAULT_ANSI[index]!)
    }
    const steps = [0, 95, 135, 175, 215, 255]
    for (let index = 16; index < 232; index += 1) {
      const offset = index - 16
      const red = steps[Math.floor(offset / 36)] ?? 0
      const green = steps[Math.floor((offset % 36) / 6)] ?? 0
      const blue = steps[offset % 6] ?? 0
      this.values[index] = (red << 16) | (green << 8) | blue
    }
    for (let index = 232; index < 256; index += 1) {
      const value = 8 + (index - 232) * 10
      this.values[index] = (value << 16) | (value << 8) | value
    }
    return true
  }

  resolve(encoded: number, foreground: boolean, boldBright: boolean): number {
    const mode = encoded & RAIN_COLOR_MODE_MASK
    if (mode === RAIN_COLOR_RGB) {
      return encoded & RAIN_COLOR_VALUE_MASK
    }
    if (mode === RAIN_COLOR_PALETTE) {
      let index = encoded & RAIN_COLOR_VALUE_MASK
      if (boldBright && index < 8) {
        index += 8
      }
      return this.values[Math.min(index, 255)] ?? 0
    }
    return foreground ? this.foreground : this.background
  }
}
