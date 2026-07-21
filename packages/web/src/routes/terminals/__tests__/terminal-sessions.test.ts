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

const t = (id: string, employee: string | undefined, role: string, status: string, act: string, lifecycle?: string) =>
  ({ id, engine: "claude", employee, sessionRole: role, status, lastActivity: act, lifecycleState: lifecycle });

describe("groupTerminalsByAgent", () => {
  it("groups by agent, pins the home chat, and lists non-archived tasks running-first", () => {
    const out = groupTerminalsByAgent([
      t("home", "fw", "home", "idle", "9"),
      t("task-run", "fw", "task", "running", "1"),
      t("task-old", "fw", "task", "idle", "5"),
      t("task-arch", "fw", "task", "idle", "8", "archived"),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].agent).toBe("fw");
    expect(out[0].home?.id).toBe("home");
    expect(out[0].visibleTasks.map(x => x.id)).toEqual(["task-run", "task-old"]); // running first; archived dropped
    expect(out[0].hasRunning).toBe(true);
  });

  it("caps visible tasks and reports hiddenCount", () => {
    const many = Array.from({ length: 8 }, (_, i) => t(`x${i}`, "fw", "task", "idle", String(8 - i)));
    const out = groupTerminalsByAgent(many, { cap: 5 });
    expect(out[0].visibleTasks).toHaveLength(5);
    expect(out[0].hiddenCount).toBe(3);
    expect(out[0].tasks).toHaveLength(8); // full list retained for "show more"
  });

  it("buckets home-less/direct sessions under 'you' and orders running groups first", () => {
    const out = groupTerminalsByAgent([
      t("a", "fw", "task", "idle", "1"),
      t("b", undefined, "task", "running", "2"),
    ]);
    expect(out.map(g => g.agent)).toEqual(["you", "fw"]); // running group floats up
  });

  it('orders groups by the group-level sort, not Map insertion order', () => {
    // fw's highest-activity row is archived (excluded from visibleTasks), so fw's
    // group activity (1) is below hvac's (5) even though fw's archived row (9) makes
    // fw insert first. The group sort must still put hvac before fw.
    const out = groupTerminalsByAgent([
      t('a-arch', 'fw', 'task', 'idle', '9', 'archived'),
      t('b1', 'hvac', 'task', 'idle', '5'),
      t('a1', 'fw', 'task', 'idle', '1'),
    ])
    expect(out.map((g) => g.agent)).toEqual(['hvac', 'fw'])
  })

  it('hasRunning ignores archived sessions', () => {
    const out = groupTerminalsByAgent([
      t('arch-run', 'fw', 'task', 'running', '9', 'archived'),
      t('live', 'fw', 'task', 'idle', '1'),
    ])
    const fw = out.find((g) => g.agent === 'fw')!
    expect(fw.hasRunning).toBe(false)
  })
})
