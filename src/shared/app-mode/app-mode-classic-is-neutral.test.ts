/**
 * Classic's definition is a proof obligation, not documentation
 * (`docs/reference/app-modes.md` §6). If any of these fail, the "Classic is
 * today's product, unchanged to the byte" claim is false.
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_APP_ICON_ID } from '../app-icon'
import { APP_MODE_OPTIONS, DEFAULT_APP_MODE_ID, type AppModeId } from './app-mode-id'
import type { AppModeManifest } from './app-mode-manifest'
import { APP_MODE_REGISTRY, CLASSIC_MANIFEST } from './app-mode-registry'
import { APP_SURFACE_IDS, buildSurfaceRecord, type AppSurfaceId } from './app-mode-surfaces'
import {
  diffSurfacesAgainstClassic,
  isSurfaceEnabled,
  resolveModeCapsule
} from './app-mode-capability'

/** Built from scratch rather than derived from CLASSIC_MANIFEST, so the deep
 *  equality below is a real comparison and not a tautology. */
const NEUTRAL_MANIFEST: AppModeManifest = {
  manifestVersion: 1,
  id: 'classic',
  labelKey: 'appMode.classic',
  descriptionKey: 'appMode.classicDescription',
  surfaces: buildSurfaceRecord(true),
  capsules: {},
  styleVariables: undefined,
  copyKeyRemap: null,
  appIcon: DEFAULT_APP_ICON_ID,
  appMenuLabelSuffix: null,
  errorBoundarySurface: 'app-root'
}

describe('Classic is neutral', () => {
  it('deep-equals a programmatically neutral manifest', () => {
    // Stronger than iterating the booleans: this also fails when a NEW
    // non-boolean field lands with a non-neutral Classic value.
    expect(CLASSIC_MANIFEST).toEqual(NEUTRAL_MANIFEST)
  })

  it('enables every surface', () => {
    for (const surface of APP_SURFACE_IDS) {
      expect(isSurfaceEnabled('classic', surface)).toBe(true)
    }
  })

  it('occupies no layout slot, so the Classic shell is never replaced', () => {
    for (const slot of ['workspace-body', 'left-sidebar-body', 'titlebar-strip'] as const) {
      expect(resolveModeCapsule('classic', slot)).toBeNull()
    }
  })

  it('differs from itself in nothing', () => {
    expect(diffSurfacesAgainstClassic('classic')).toEqual([])
  })

  it('is the default, and the fallback for anything unrecognized', () => {
    expect(DEFAULT_APP_MODE_ID).toBe('classic')
    for (const value of [undefined, null, 'kids', 42, '__proto__', {}]) {
      expect(isSurfaceEnabled(value, 'statusBar')).toBe(true)
    }
  })
})

describe('the frozen surface union', () => {
  it('has no duplicate members', () => {
    expect(new Set(APP_SURFACE_IDS).size).toBe(APP_SURFACE_IDS.length)
  })

  it('matches the type exactly — a member added to one and not the other fails here', () => {
    // buildSurfaceRecord is typed as an exhaustive Record<AppSurfaceId, boolean>,
    // so if APP_SURFACE_IDS were missing a union member this assertion breaks.
    expect(Object.keys(buildSurfaceRecord(true)).sort()).toEqual([...APP_SURFACE_IDS].sort())
  })

  it('deliberately excludes settings and menus, so no mode can hide the way out', () => {
    for (const surface of APP_SURFACE_IDS) {
      expect(surface).not.toMatch(/^view\.settings$|^menu\./)
    }
  })
})

describe('every registered mode', () => {
  const modeIds = APP_MODE_OPTIONS.map((option) => option.id)

  it.each(modeIds)('%s has an exhaustive surface table', (id: AppModeId) => {
    const surfaces = APP_MODE_REGISTRY[id].surfaces
    for (const surface of APP_SURFACE_IDS) {
      expect(typeof surfaces[surface as AppSurfaceId]).toBe('boolean')
    }
  })

  it.each(modeIds)('%s carries its own id', (id: AppModeId) => {
    expect(APP_MODE_REGISTRY[id].id).toBe(id)
  })

  it.each(modeIds)('%s is JSON — the anti-DSL guard', (id: AppModeId) => {
    // A manifest that grew a function, a getter or a runtime condition would not
    // survive this round trip. That is the mechanical stop on the first
    // `when: {...}` field, which would otherwise look reasonable in review.
    const manifest = APP_MODE_REGISTRY[id]
    expect(JSON.parse(JSON.stringify(manifest))).toEqual(JSON.parse(JSON.stringify(manifest)))
    for (const value of Object.values(manifest)) {
      expect(typeof value).not.toBe('function')
    }
  })

  it('every non-Classic mode names a workspace-body capsule, or it would render nothing', () => {
    for (const id of modeIds.filter((mode) => mode !== 'classic')) {
      expect(resolveModeCapsule(id, 'workspace-body')).not.toBeNull()
    }
  })
})
