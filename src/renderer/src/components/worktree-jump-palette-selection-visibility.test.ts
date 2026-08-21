import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Why source-invariant: the fix is a CSS cascade win (a --accent≈--background collision that
// jsdom cannot compute). The reachable facts are that every real palette row carries the
// `jump-palette-item` hook, drops the invisible flat accent, and that main.css out-specifies
// CommandItem's own data-[selected=true]:bg-accent so light-mode selection is visible.
const palette = readFileSync(join(__dirname, 'WorktreeJumpPalette.tsx'), 'utf8')
const mainCss = readFileSync(join(__dirname, '../assets/main.css'), 'utf8')

describe('WorktreeJumpPalette keyboard-selection visibility', () => {
  it('routes every row through the shared jump-palette-item classname', () => {
    expect(palette).toContain('const JUMP_PALETTE_ITEM_CLASSNAME =')
    // The hook class the main.css recipe targets must live in the shared constant.
    const constDef = palette.slice(palette.indexOf('const JUMP_PALETTE_ITEM_CLASSNAME ='))
    expect(constDef.slice(0, 400)).toContain('jump-palette-item')

    // One apply per selectable row type (create + worktree + folder + settings + recent-tab +
    // simulator + browser) — 7 today; the constant is the only path rows may use.
    const applied = palette.match(/cn\(JUMP_PALETTE_ITEM_CLASSNAME/g) ?? []
    expect(applied.length).toBeGreaterThanOrEqual(7)
  })

  it('drops the flat data-[selected=true]:bg-accent that vanished on light popovers', () => {
    // Plant the regression back on any row and this fails — the whole point of the fix.
    expect(palette).not.toContain('data-[selected=true]:bg-accent')
  })

  it('defines a main.css recipe that out-specifies CommandItem in both themes', () => {
    // data-slot qualifier is load-bearing: CommandItem also sets data-[selected=true]:bg-accent,
    // so the selector must beat that utility, not merely add to it.
    expect(mainCss).toContain("[data-slot='command-item'].jump-palette-item[data-selected='true']")
    expect(mainCss).toContain(
      ".dark [data-slot='command-item'].jump-palette-item[data-selected='true']"
    )
    // Light mode mixes foreground into background (flat accent is invisible there); the surface
    // is exposed as a var so nested cutouts can match without a hardcoded color.
    expect(mainCss).toContain(
      '--jump-palette-selection-surface: color-mix(in srgb, var(--foreground) 12%, var(--background))'
    )
  })
})
