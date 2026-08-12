import { describe, expect, it } from 'vitest'
import {
  imagePreviewBindings,
  mergeLandedImagePreviews
} from './mobile-native-chat-image-preview-echo'

describe('imagePreviewBindings', () => {
  it('binds every photo of a captioned send to the single prompt turn its echo claimed', () => {
    expect(
      imagePreviewBindings({ normalizedText: 'look', images: ['file:///a.jpg', 'file:///b.jpg'] }, [
        'u-prompt'
      ])
    ).toEqual([['u-prompt', ['file:///a.jpg', 'file:///b.jpg']]])
  })

  it('binds each photo of an image-only send to its own echo turn, in send order', () => {
    expect(
      imagePreviewBindings({ normalizedText: '', images: ['file:///a.jpg', 'file:///b.jpg'] }, [
        'u1',
        'u2'
      ])
    ).toEqual([
      ['u1', ['file:///a.jpg']],
      ['u2', ['file:///b.jpg']]
    ])
  })

  it('only binds as many photos as echo turns were claimed', () => {
    expect(
      imagePreviewBindings({ normalizedText: '', images: ['file:///a.jpg', 'file:///b.jpg'] }, [
        'u1'
      ])
    ).toEqual([['u1', ['file:///a.jpg']]])
  })

  it('returns nothing when the send carried no images or claimed no turns', () => {
    expect(imagePreviewBindings({ normalizedText: 'hi' }, ['u1'])).toEqual([])
    expect(imagePreviewBindings({ normalizedText: '', images: ['file:///a.jpg'] }, [])).toEqual([])
  })
})

describe('mergeLandedImagePreviews', () => {
  it('accumulates bindings under the session, keyed by message id', () => {
    const first = mergeLandedImagePreviews({}, 's', [['u1', ['file:///a.jpg']]])
    const second = mergeLandedImagePreviews(first, 's', [['u2', ['file:///b.jpg']]])
    expect(second).toEqual({ s: { u1: ['file:///a.jpg'], u2: ['file:///b.jpg'] } })
  })

  it('replaces a prior binding for the same message id (re-inserted last)', () => {
    const merged = mergeLandedImagePreviews({ s: { u1: ['file:///old.jpg'] } }, 's', [
      ['u1', ['file:///new.jpg']]
    ])
    expect(merged.s).toEqual({ u1: ['file:///new.jpg'] })
  })

  it('caps retained photos to the most recent 32 per session', () => {
    let map: Record<string, Record<string, string[]>> = {}
    for (let i = 0; i < 40; i += 1) {
      map = mergeLandedImagePreviews(map, 's', [[`u${i}`, [`file:///${i}.jpg`]]])
    }
    const ids = Object.keys(map.s ?? {})
    expect(ids).toHaveLength(32)
    expect(ids[0]).toBe('u8')
    expect(ids[31]).toBe('u39')
  })

  it('caps retained sessions to the most recent 8', () => {
    let map: Record<string, Record<string, string[]>> = {}
    for (let i = 0; i < 12; i += 1) {
      map = mergeLandedImagePreviews(map, `s${i}`, [['u', [`file:///${i}.jpg`]]])
    }
    expect(Object.keys(map)).toEqual(['s4', 's5', 's6', 's7', 's8', 's9', 's10', 's11'])
  })
})
