import { describe, expect, it } from 'vitest'
import { summarizeToolInput } from '../tool-summary'

describe('summarizeToolInput', () => {
  it('shows the Bash command', () => {
    expect(summarizeToolInput('Bash', JSON.stringify({ command: 'npm test' }))).toBe('npm test')
  })

  it('collapses a multi-line command to a single line', () => {
    expect(summarizeToolInput('Bash', JSON.stringify({ command: 'cd /x &&\n  npm test' }))).toBe('cd /x && npm test')
  })

  it('shows the file basename for Read/Edit/Write', () => {
    expect(summarizeToolInput('Read', JSON.stringify({ file_path: '/a/b/chat-sidebar.tsx' }))).toBe('chat-sidebar.tsx')
    expect(summarizeToolInput('Edit', JSON.stringify({ file_path: '/a/pkg.json' }))).toBe('pkg.json')
    expect(summarizeToolInput('Write', JSON.stringify({ file_path: 'y.ts' }))).toBe('y.ts')
  })

  it('shows the pattern for Grep/Glob', () => {
    expect(summarizeToolInput('Grep', JSON.stringify({ pattern: 'foo', path: 'src' }))).toBe('foo')
    expect(summarizeToolInput('Glob', JSON.stringify({ pattern: '**/*.ts' }))).toBe('**/*.ts')
  })

  it('shows the host for WebFetch', () => {
    expect(summarizeToolInput('WebFetch', JSON.stringify({ url: 'https://example.com/a/b' }))).toBe('example.com')
  })

  it('shows the description for Task', () => {
    expect(summarizeToolInput('Task', JSON.stringify({ description: 'do the thing', subagent_type: 'x' }))).toBe('do the thing')
  })

  it('returns empty for unknown tools or missing input', () => {
    expect(summarizeToolInput('MysteryTool', JSON.stringify({ foo: 'bar' }))).toBe('')
    expect(summarizeToolInput('Bash', undefined)).toBe('')
    expect(summarizeToolInput('Bash', '')).toBe('')
  })

  it('recovers a field from truncated / invalid JSON', () => {
    // The gateway truncates tool input to 200 chars, which can cut valid JSON.
    expect(
      summarizeToolInput('Bash', '{"command":"echo hello world and a lot more text that got cut of'),
    ).toBe('echo hello world and a lot more text that got cut of')
  })

  it('truncates very long summaries with an ellipsis', () => {
    const out = summarizeToolInput('Bash', JSON.stringify({ command: 'x'.repeat(200) }))
    expect(out.length).toBeLessThanOrEqual(61)
    expect(out.endsWith('…')).toBe(true)
  })
})
