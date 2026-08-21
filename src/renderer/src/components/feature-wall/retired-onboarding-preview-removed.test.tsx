import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import en from '@/i18n/locales/en.json'
import { WorkspacesAnimatedVisual } from './WorkspacesAnimatedVisual'

// #13489 retired the onboarding preview. Its glyph module (feature-tour-preview-glyphs)
// was the only local source of the codex mark; the surviving animated visuals now render
// the shared OpenAIIcon instead. This guard fails if any of that comes back.
function reachesRetiredPreview(source: string): boolean {
  return /feature-tour-preview-glyphs|CodexInlineIcon/.test(source)
}

const RETIRED_MODULES = [
  'FeatureTourPreview.tsx',
  'FeatureTourPreview.test.tsx',
  'FeatureTourTerminalFrame.tsx',
  'FeatureTourWorkspaceCard.tsx',
  'feature-tour-preview-copy.ts',
  'feature-tour-preview-glyphs.tsx'
] as const

// The two surviving visuals that used to pull the codex glyph from the retired module.
const SURVIVING_CODEX_VISUALS = [
  'WorkspacesAnimatedVisual.tsx',
  'WorkbenchAnimatedVisual.tsx'
] as const

function readSibling(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), 'utf8')
}

describe('retired onboarding preview removed (#13489)', () => {
  it('detects a source that still reaches for the retired preview glyphs', () => {
    // Why: prove the guard fires on a violation before trusting it on real sources.
    expect(
      reachesRetiredPreview("import { CodexInlineIcon } from './feature-tour-preview-glyphs'")
    ).toBe(true)
  })

  it('deletes every retired preview module', () => {
    for (const name of RETIRED_MODULES) {
      expect(existsSync(fileURLToPath(new URL(`./${name}`, import.meta.url))), name).toBe(false)
    }
  })

  it('keeps the surviving codex visuals on the shared OpenAIIcon, not the retired glyphs', () => {
    for (const name of SURVIVING_CODEX_VISUALS) {
      const source = readSibling(name)
      expect(reachesRetiredPreview(source), name).toBe(false)
      expect(source, name).toContain('OpenAIIcon')
      expect(source, name).toContain("from '../status-bar/icons'")
    }
  })

  it('renders the shared OpenAI mark for the codex agent', () => {
    // Why: exercise the production render path so the swap is proven reachable, not just
    // present in source. fill-rule="evenodd" is OpenAIIcon's signature; the retired
    // CodexInlineIcon never emitted it.
    const html = renderToStaticMarkup(<WorkspacesAnimatedVisual reducedMotion />)
    expect(html).toContain('M9.205 8.658')
    expect(html).toContain('fill-rule="evenodd"')
  })

  it('drops the retired preview localization namespaces', () => {
    const auto = (en as { auto?: { components?: Record<string, Record<string, unknown>> } }).auto
    const wall = auto?.components?.feature as Record<string, unknown> | undefined
    expect((wall?.wall as Record<string, unknown> | undefined)?.FeatureTourPreview).toBeUndefined()
    expect(
      (wall?.wall as Record<string, unknown> | undefined)?.FeatureTourWorkspaceCard
    ).toBeUndefined()
    expect(
      (auto?.components?.onboarding as Record<string, unknown> | undefined)?.OnboardingTourStep
    ).toBeUndefined()
  })
})
