import { describe, expect, it } from 'vitest'
import { selectTerminalSessions } from '../terminal-sessions'

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
