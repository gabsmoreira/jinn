import { describe, expect, it } from 'vitest'
import { computeLineDiff } from '../tool-diff'

const types = (d: { type: string }[]) => d.map((l) => l.type).join(',')

describe('computeLineDiff', () => {
  it('marks identical text as all context', () => {
    expect(types(computeLineDiff('a\nb\nc', 'a\nb\nc'))).toBe('ctx,ctx,ctx')
  })

  it('treats an empty old side as all additions (new file / Write)', () => {
    expect(computeLineDiff('', 'x\ny')).toEqual([
      { type: 'add', text: 'x' },
      { type: 'add', text: 'y' },
    ])
  })

  it('treats an empty new side as all deletions', () => {
    expect(computeLineDiff('x\ny', '')).toEqual([
      { type: 'del', text: 'x' },
      { type: 'del', text: 'y' },
    ])
  })

  it('produces del then add for a changed line, keeping surrounding context', () => {
    const d = computeLineDiff('a\nfoo\nc', 'a\nbar\nc')
    expect(types(d)).toBe('ctx,del,add,ctx')
    expect(d[1]).toEqual({ type: 'del', text: 'foo' })
    expect(d[2]).toEqual({ type: 'add', text: 'bar' })
  })

  it('ignores a single trailing newline (no phantom empty line)', () => {
    const d = computeLineDiff('a\n', 'a\nb\n')
    expect(types(d)).toBe('ctx,add')
    expect(d[1]).toEqual({ type: 'add', text: 'b' })
  })

  it('handles a pure insertion into the middle', () => {
    const d = computeLineDiff('a\nc', 'a\nb\nc')
    expect(types(d)).toBe('ctx,add,ctx')
    expect(d[1]).toEqual({ type: 'add', text: 'b' })
  })
})
