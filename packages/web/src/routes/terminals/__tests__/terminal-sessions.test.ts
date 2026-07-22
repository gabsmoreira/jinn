import { describe, expect, it } from 'vitest'
import { selectTerminalSessions, groupTerminalsByAgent } from '../terminal-sessions'

const s = (id: string, engine: string | undefined, status: string, lastActivity: string) =>
  ({ id, engine, status, lastActivity })

describe('selectTerminalSessions', () => {
  it('keeps only CLI-capable engines (claude/codex/antigravity/grok)', () => {
    const out = selectTerminalSessions([
      s('a', 'claude', 'idle', '3'),
      s('b', 'pi', 'idle', '2'),
      s('c', 'codex', 'idle', '1'),
      s('d', 'hermes', 'idle', '4'),
      s('e', 'grok', 'idle', '0'),
    ])
    expect(out.map((x) => x.id).sort()).toEqual(['a', 'c', 'e'])
  })

  it('excludes archived sessions', () => {
    const out = selectTerminalSessions([
      { id: 'a', engine: 'claude', status: 'idle', lastActivity: '2' },
      { id: 'b', engine: 'claude', status: 'idle', lastActivity: '1', archivedAt: '2026-01-01' },
    ])
    expect(out.map((x) => x.id)).toEqual(['a'])
  })

  it('orders running sessions first', () => {
    const out = selectTerminalSessions([
      s('a', 'claude', 'idle', '5'),
      s('b', 'claude', 'running', '1'),
      s('c', 'codex', 'idle', '3'),
    ])
    expect(out.map((x) => x.id)).toEqual(['b', 'a', 'c'])
  })

  it('within a run-state group, orders by most-recent activity', () => {
    const out = selectTerminalSessions([
      s('a', 'claude', 'idle', '1'),
      s('b', 'claude', 'idle', '3'),
      s('c', 'claude', 'idle', '2'),
    ])
    expect(out.map((x) => x.id)).toEqual(['b', 'c', 'a'])
  })

  it('falls back to createdAt when lastActivity is missing', () => {
    const out = selectTerminalSessions([
      { id: 'a', engine: 'claude', status: 'idle', createdAt: '1' },
      { id: 'b', engine: 'claude', status: 'idle', createdAt: '2' },
    ])
    expect(out.map((x) => x.id)).toEqual(['b', 'a'])
  })

  it('drops sessions with no engine', () => {
    const out = selectTerminalSessions([
      { id: 'a', status: 'idle', lastActivity: '1' },
      s('b', 'claude', 'idle', '2'),
    ])
    expect(out.map((x) => x.id)).toEqual(['b'])
  })
})

const t = (id: string, employee: string | undefined, status: string, act: string, archivedAt?: string) =>
  ({ id, engine: 'claude', employee, status, lastActivity: act, archivedAt })

describe('groupTerminalsByAgent', () => {
  it('groups by agent (employee), running-first within a group', () => {
    const out = groupTerminalsByAgent([
      t('task-run', 'fw', 'running', '1'),
      t('task-old', 'fw', 'idle', '5'),
    ])
    expect(out).toHaveLength(1)
    expect(out[0].agent).toBe('fw')
    expect(out[0].visibleTasks.map((x) => x.id)).toEqual(['task-run', 'task-old'])
    expect(out[0].hasRunning).toBe(true)
  })

  it('excludes archived sessions from groups', () => {
    const out = groupTerminalsByAgent([
      t('live', 'fw', 'idle', '1'),
      t('arch', 'fw', 'idle', '8', '2026-01-01'),
    ])
    expect(out[0].tasks.map((x) => x.id)).toEqual(['live'])
  })

  it('caps visible tasks and reports hiddenCount (full list retained)', () => {
    const many = Array.from({ length: 8 }, (_, i) => t(`x${i}`, 'fw', 'idle', String(8 - i)))
    const out = groupTerminalsByAgent(many, { cap: 5 })
    expect(out[0].visibleTasks).toHaveLength(5)
    expect(out[0].hiddenCount).toBe(3)
    expect(out[0].tasks).toHaveLength(8)
  })

  it("buckets sessions with no employee under 'you' and floats running groups first", () => {
    const out = groupTerminalsByAgent([
      t('a', 'fw', 'idle', '1'),
      t('b', undefined, 'running', '2'),
    ])
    expect(out.map((g) => g.agent)).toEqual(['you', 'fw'])
  })

  it('orders non-running groups by group-level activity', () => {
    const out = groupTerminalsByAgent([
      t('a1', 'fw', 'idle', '1'),
      t('b1', 'hvac', 'idle', '5'),
    ])
    expect(out.map((g) => g.agent)).toEqual(['hvac', 'fw'])
  })

  it('hasRunning ignores archived sessions', () => {
    const out = groupTerminalsByAgent([
      t('arch-run', 'fw', 'running', '9', '2026-01-01'),
      t('live', 'fw', 'idle', '1'),
    ])
    expect(out[0].hasRunning).toBe(false)
  })

  it('floats pinned tasks to the top of their group (stable otherwise)', () => {
    const out = groupTerminalsByAgent(
      [
        t('a', 'fw', 'idle', '3'),
        t('b', 'fw', 'idle', '2'),
        t('c', 'fw', 'idle', '1'),
      ],
      { pinnedIds: new Set(['c']) },
    )
    expect(out[0].tasks.map((x) => x.id)).toEqual(['c', 'a', 'b'])
    expect(out[0].visibleTasks.map((x) => x.id)).toEqual(['c', 'a', 'b'])
  })

  it('without pinnedIds, ordering is unchanged', () => {
    const out = groupTerminalsByAgent([
      t('a', 'fw', 'idle', '3'),
      t('b', 'fw', 'idle', '1'),
    ])
    expect(out[0].tasks.map((x) => x.id)).toEqual(['a', 'b'])
  })
})
