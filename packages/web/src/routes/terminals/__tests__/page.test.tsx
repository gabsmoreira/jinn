import { render, screen, fireEvent } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Mock the shell + heavy children so the page renders in isolation.
vi.mock('@/components/page-layout', () => ({ PageLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }))
vi.mock('@/components/cli-terminal', () => ({ CliTerminal: () => <div data-testid="cli" /> }))
vi.mock('@/components/ui/employee-avatar', () => ({ EmployeeAvatar: () => <div /> }))
vi.mock('@/hooks/use-sessions', () => ({
  useSessions: () => ({
    data: [
      { id: 's1', engine: 'claude', status: 'running', employee: 'fw', title: 'Build firmware', lastActivity: '2' },
      { id: 's2', engine: 'claude', status: 'idle', employee: 'fw', title: 'Refactor', lastActivity: '1' },
    ],
  }),
  useUpdateSession: () => ({ mutate: vi.fn() }),
  useDeleteSession: () => ({ mutate: vi.fn() }),
  useDuplicateSession: () => ({ mutateAsync: vi.fn() }),
}))

import TerminalsPage from '../page'

describe('TerminalsPage', () => {
  beforeEach(() => localStorage.clear())

  it('renders an agent group with its terminal rows', () => {
    render(<TerminalsPage />)
    expect(screen.getByText('Fw')).toBeTruthy()
    expect(screen.getByText('Build firmware')).toBeTruthy()
    expect(screen.getByText('Refactor')).toBeTruthy()
  })

  it('collapses a group to just its header when the header is clicked', () => {
    render(<TerminalsPage />)
    expect(screen.getByText('Refactor')).toBeTruthy()
    fireEvent.click(screen.getByText('Fw'))
    expect(screen.queryByText('Refactor')).toBeNull()
  })
})
