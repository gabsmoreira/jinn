import { afterEach, describe, expect, it, vi } from 'vitest'
import { activeGroupName, buildAgentGroups, hasBackgroundActivity, isDirectSession, isRecentError, resolveRowIdentity } from '../chat-sidebar'

// Minimal web session fixture — buildAgentGroups only reads these fields.
type TestSession = {
  id: string
  source: string
  sourceRef: string
  employee: string | null
  lastActivity: string
}
const sess = (
  id: string,
  employee: string | undefined,
  lastActivity: string,
  extra: Record<string, unknown> = {},
): TestSession => ({ id, source: 'web', sourceRef: `web:${id}`, employee: employee ?? null, lastActivity, ...extra })

afterEach(() => {
  vi.useRealTimers()
})

describe('chat sidebar grouping helpers', () => {
  it('treats only employee-less, non-cron sessions as direct', () => {
    expect(isDirectSession({ source: 'web', sourceRef: 'web:1' })).toBe(true)
    expect(isDirectSession({ source: 'web', sourceRef: 'web:2', employee: 'jinn' })).toBe(false)
    expect(isDirectSession({ source: 'cron', sourceRef: 'cron:daily' })).toBe(false)
    expect(isDirectSession({ source: 'web', sourceRef: 'cron:daily' })).toBe(false)
  })

  it('treats a session tagged with the portal slug as direct (case-insensitive)', () => {
    // ~30 child sessions were created with employee === portal slug; there is no
    // org employee by that name, so they must bucket into the direct/COO group
    // rather than spawn a phantom duplicate group.
    expect(isDirectSession({ source: 'web', sourceRef: 'web:3', employee: 'jimbo' }, 'jimbo')).toBe(true)
    expect(isDirectSession({ source: 'web', sourceRef: 'web:4', employee: 'Jimbo' }, 'jimbo')).toBe(true)
    // a real org employee is never folded into direct
    expect(isDirectSession({ source: 'web', sourceRef: 'web:5', employee: 'jinn' }, 'jimbo')).toBe(false)
    // a portal-slug row is still a separate group when no slug is supplied
    expect(isDirectSession({ source: 'web', sourceRef: 'web:6', employee: 'jimbo' })).toBe(false)
  })
})

describe('buildAgentGroups', () => {
  const opts = (over: Partial<{ counts: Record<string, number>; pinnedKeys: Set<string> }> = {}) => ({
    portalSlug: 'jimbo',
    counts: over.counts ?? {},
    pinnedKeys: over.pinnedKeys ?? new Set<string>(),
  })

  it('collapses an agent with several tasks into ONE group', () => {
    const groups = buildAgentGroups(
      [
        sess('a1', 'firmware-lead', '2026-06-10T10:00:00Z'),
        sess('a2', 'firmware-lead', '2026-06-10T12:00:00Z'),
        sess('a3', 'firmware-lead', '2026-06-10T08:00:00Z'),
      ],
      opts(),
    )
    expect(groups).toHaveLength(1)
    expect(groups[0].employeeName).toBe('firmware-lead')
    expect(groups[0].total).toBe(3)
  })

  it('orders tasks within a group newest-first', () => {
    const groups = buildAgentGroups(
      [
        sess('a1', 'firmware-lead', '2026-06-10T10:00:00Z'),
        sess('a2', 'firmware-lead', '2026-06-10T12:00:00Z'),
        sess('a3', 'firmware-lead', '2026-06-10T08:00:00Z'),
      ],
      opts(),
    )
    expect(groups[0].sessions.map((s) => s.id)).toEqual(['a2', 'a1', 'a3'])
  })

  it('orders groups by most-recent activity (agent last touched on top)', () => {
    const groups = buildAgentGroups(
      [
        sess('a1', 'firmware-lead', '2026-06-10T09:00:00Z'),
        sess('b1', 'thermostat-firmware', '2026-06-10T12:00:00Z'),
        sess('c1', 'longrange-firmware', '2026-06-10T10:00:00Z'),
      ],
      opts(),
    )
    expect(groups.map((g) => g.employeeName)).toEqual([
      'thermostat-firmware',
      'longrange-firmware',
      'firmware-lead',
    ])
  })

  it('puts pinned agents first regardless of recency, and uses counts for total', () => {
    const groups = buildAgentGroups(
      [
        sess('a1', 'lead-a', '2026-06-10T09:00:00Z'),
        sess('b1', 'lead-b', '2026-06-10T12:00:00Z'),
      ],
      opts({ counts: { 'lead-a': 5 }, pinnedKeys: new Set(['emp:lead-a']) }),
    )
    expect(groups[0].employeeName).toBe('lead-a')
    expect(groups[0].pinned).toBe(true)
    expect(groups[0].total).toBe(5) // authoritative server count, not loaded length
    expect(groups[1].employeeName).toBe('lead-b')
  })

  it('folds employee-less and portal-slug sessions into a single direct group', () => {
    const groups = buildAgentGroups(
      [
        sess('d1', undefined, '2026-06-10T10:00:00Z'),
        sess('d2', 'jimbo', '2026-06-10T11:00:00Z'), // portal slug → direct
      ],
      opts(),
    )
    expect(groups).toHaveLength(1)
    expect(groups[0].groupKey).toBe('__direct__')
    expect(groups[0].isDirect).toBe(true)
    expect(groups[0].sessions.map((s) => s.id)).toEqual(['d2', 'd1'])
  })

  it('excludes cron sessions (they render in their own section)', () => {
    const groups = buildAgentGroups(
      [
        { id: 'c1', source: 'cron', sourceRef: 'cron:daily', employee: null, lastActivity: '2026-06-10T12:00:00Z' },
        sess('a1', 'firmware-lead', '2026-06-10T10:00:00Z'),
      ],
      opts(),
    )
    expect(groups.map((g) => g.groupKey)).toEqual(['firmware-lead'])
  })
})

describe('activeGroupName', () => {
  const groups = buildAgentGroups(
    [
      sess('a1', 'lead-a', '2026-06-10T09:00:00Z'),
      sess('b1', 'lead-b', '2026-06-10T12:00:00Z'),
    ],
    { portalSlug: 'jimbo', counts: {}, pinnedKeys: new Set<string>() },
  )

  it('returns the group that holds the open chat', () => {
    expect(activeGroupName(groups, 'a1')).toBe('lead-a')
    expect(activeGroupName(groups, 'b1')).toBe('lead-b')
  })

  it('returns undefined for an unknown or null selection', () => {
    expect(activeGroupName(groups, 'nope')).toBeUndefined()
    expect(activeGroupName(groups, null)).toBeUndefined()
  })
})

describe('chat sidebar background activity', () => {
  it('ignores stale cached background activity', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-10T10:10:00Z'))

    expect(
      hasBackgroundActivity({
        status: 'idle',
        backgroundActivity: {
          activeStreams: 1,
          lastActivityAt: '2026-06-10T10:00:00Z',
        },
      }),
    ).toBe(false)
  })

  it('keeps fresh idle background activity visible', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-10T10:01:00Z'))

    expect(
      hasBackgroundActivity({
        status: 'idle',
        backgroundActivity: {
          activeStreams: 1,
          lastActivityAt: '2026-06-10T10:00:00Z',
        },
      }),
    ).toBe(true)
  })
})

describe('chat sidebar recent-error dot gating', () => {
  // Fixed "now"; the helper takes nowMs so we never read Date.now() at module load.
  const now = new Date('2026-06-15T12:00:00Z').getTime()
  const HOUR = 60 * 60 * 1000

  it('flags an error whose last activity is within the 24h window (→ red)', () => {
    const oneHourAgo = new Date(now - HOUR).toISOString()
    expect(isRecentError('error', oneHourAgo, now)).toBe(true)
  })

  it('does NOT flag an error whose last activity is older than 24h (→ not red)', () => {
    const twoDaysAgo = new Date(now - 48 * HOUR).toISOString()
    expect(isRecentError('error', twoDaysAgo, now)).toBe(false)
  })

  it('never flags a non-error status, even when recent', () => {
    const oneHourAgo = new Date(now - HOUR).toISOString()
    expect(isRecentError('idle', oneHourAgo, now)).toBe(false)
    expect(isRecentError('running', oneHourAgo, now)).toBe(false)
    expect(isRecentError(undefined, oneHourAgo, now)).toBe(false)
  })

  it('treats a missing or unparseable timestamp as not-recent (→ not red)', () => {
    expect(isRecentError('error', '', now)).toBe(false)
    expect(isRecentError('error', 'not-a-date', now)).toBe(false)
  })

  it('treats the 24h boundary as stale (strictly inside the window is red)', () => {
    const exactly24h = new Date(now - 24 * HOUR).toISOString()
    expect(isRecentError('error', exactly24h, now)).toBe(false)
    const justInside = new Date(now - 24 * HOUR + 1000).toISOString()
    expect(isRecentError('error', justInside, now)).toBe(true)
  })
})

describe('chat sidebar search row identity', () => {
  const opts = {
    portalSlug: 'jimbo',
    portalName: 'Jimbo',
    employeeData: new Map([
      [
        'jinn',
        {
          name: 'jinn',
          displayName: 'Jinn Dev',
          department: 'platform',
          rank: 'employee' as const,
          engine: 'claude',
          model: 'opus',
          persona: '',
        },
      ],
    ]),
  }

  // The API types employee as `string | null`, but the local Session interface
  // narrows it to `string | undefined`; the server can still send null at
  // runtime. Cast to reproduce that real-world shape in the test.
  const cron = { source: 'cron', sourceRef: 'cron:nightly', employee: null } as unknown as Parameters<
    typeof resolveRowIdentity
  >[0]

  // Regression: search flattens cron rows (which the grouped view renders in a
  // separate cron section). isDirectSession returns false for cron sessions, so
  // the old `s.employee!` assertion fed `null` to titleCase → `null.split('-')`
  // → "Cannot read properties of null (reading 'split')". Must not throw.
  it('does not crash on a cron session with a null employee', () => {
    expect(() => resolveRowIdentity(cron, opts)).not.toThrow()
    expect(resolveRowIdentity(cron, opts)).toEqual({ avatarName: 'jimbo', displayName: 'Jimbo' })
  })

  it('does not crash on a session with an undefined employee', () => {
    expect(() => resolveRowIdentity({ source: 'web', sourceRef: 'web:1' }, opts)).not.toThrow()
    expect(resolveRowIdentity({ source: 'web', sourceRef: 'web:1' }, opts)).toEqual({
      avatarName: 'jimbo',
      displayName: 'Jimbo',
    })
  })

  it('resolves a real employee to its org display name', () => {
    expect(
      resolveRowIdentity({ source: 'web', sourceRef: 'web:2', employee: 'jinn' }, opts),
    ).toEqual({ avatarName: 'jinn', displayName: 'Jinn Dev' })
  })

  it('title-cases an employee with no org profile rather than crashing', () => {
    expect(
      resolveRowIdentity({ source: 'web', sourceRef: 'web:3', employee: 'magic-switch-lead' }, opts),
    ).toEqual({ avatarName: 'magic-switch-lead', displayName: 'Magic Switch Lead' })
  })
})
