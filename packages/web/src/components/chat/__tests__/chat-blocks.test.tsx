import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ChatBlockInline } from '../chat-blocks'
import type { ChatBlock } from '@/lib/blocks'
import { api } from '@/lib/api'

describe('ChatBlockInline', () => {
  it('renders a task-list block with status rows', () => {
    const block: ChatBlock = {
      id: 'plan',
      type: 'task-list',
      version: 1,
      title: 'Plan',
      status: 'running',
      payload: {
        items: [
          { id: 'a', text: 'Read code', status: 'done' },
          { id: 'b', text: 'Patch UI', status: 'running' },
        ],
      },
    }
    render(<ChatBlockInline block={block} />)
    expect(screen.getByText('Plan')).toBeTruthy()
    expect(screen.getByText('Read code')).toBeTruthy()
    expect(screen.getByText('Patch UI')).toBeTruthy()
  })

  const questionBlock: ChatBlock = {
    id: 'askq-tool_1', type: 'question', version: 1,
    payload: {
      toolId: 'tool_1', answered: false,
      questions: [{ header: 'Color', question: 'Pick a color', multiSelect: false,
        options: [{ label: 'Red', description: 'The color red' }, { label: 'Green' }] }],
    },
  }

  it('renders question options and answers on click', async () => {
    const spy = vi.spyOn(api, 'answerQuestion').mockResolvedValue({ status: 'answered', sessionId: 's1' })
    render(<ChatBlockInline block={questionBlock} sessionId="s1" />)
    expect(screen.getByText('Pick a color')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Green/ }))
    expect(spy).toHaveBeenCalledWith('s1', [1])
  })

  it('renders multi-select read-only (no answer call)', () => {
    const spy = vi.spyOn(api, 'answerQuestion').mockClear().mockResolvedValue({ status: 'answered', sessionId: 's1' })
    const multi: ChatBlock = { ...questionBlock, payload: { ...questionBlock.payload,
      questions: [{ ...(questionBlock.payload.questions as Record<string, unknown>[])[0], multiSelect: true }] } }
    render(<ChatBlockInline block={multi} sessionId="s1" />)
    expect(screen.getByText(/terminal view/i)).toBeTruthy()
    expect(spy).not.toHaveBeenCalled()
  })
})
