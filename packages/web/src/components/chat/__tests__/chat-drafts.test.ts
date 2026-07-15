import { beforeEach, describe, expect, it } from 'vitest'
import { clearDraft, loadDraft, saveDraft } from '../chat-drafts'

beforeEach(() => {
  localStorage.clear()
})

describe('chat drafts', () => {
  it('saves and restores a draft for a session', () => {
    saveDraft('s1', 'hello world')
    expect(loadDraft('s1')).toBe('hello world')
  })

  it('returns an empty string for a session with no draft', () => {
    expect(loadDraft('unknown')).toBe('')
  })

  it('keeps drafts isolated per session', () => {
    saveDraft('s1', 'draft one')
    saveDraft('s2', 'draft two')
    expect(loadDraft('s1')).toBe('draft one')
    expect(loadDraft('s2')).toBe('draft two')
  })

  it('clears a draft when saved empty (e.g. on send)', () => {
    saveDraft('s1', 'hello')
    saveDraft('s1', '')
    expect(loadDraft('s1')).toBe('')
  })

  it('clearDraft removes the draft', () => {
    saveDraft('s1', 'hello')
    clearDraft('s1')
    expect(loadDraft('s1')).toBe('')
  })

  it('uses one shared new-chat bucket for a null/undefined session id', () => {
    saveDraft(null, 'new chat draft')
    expect(loadDraft(null)).toBe('new chat draft')
    expect(loadDraft(undefined)).toBe('new chat draft')
    expect(loadDraft('s1')).toBe('') // distinct from real sessions
  })

  it('survives a reload (reads back from localStorage, not memory)', () => {
    saveDraft('s1', 'persisted')
    // A fresh read with no in-module cache must still find it.
    expect(loadDraft('s1')).toBe('persisted')
    expect(localStorage.getItem('jinn-chat-drafts')).toContain('persisted')
  })

  it('evicts the oldest drafts beyond the cap (LRU by timestamp)', () => {
    // 51 drafts, increasing timestamps; cap is 50 → the oldest is evicted.
    for (let i = 0; i <= 50; i++) saveDraft(`s${i}`, `text ${i}`, 1000 + i)
    expect(loadDraft('s0')).toBe('') // oldest evicted
    expect(loadDraft('s50')).toBe('text 50') // newest kept
  })

  it('never throws when localStorage is unavailable', () => {
    const orig = globalThis.localStorage
    // @ts-expect-error force a broken storage
    globalThis.localStorage = { getItem() { throw new Error('nope') }, setItem() { throw new Error('nope') } }
    expect(() => saveDraft('s1', 'x')).not.toThrow()
    expect(loadDraft('s1')).toBe('')
    globalThis.localStorage = orig
  })
})
