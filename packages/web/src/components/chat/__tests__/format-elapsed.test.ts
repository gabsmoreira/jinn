import { describe, expect, it } from 'vitest'
import { formatElapsed } from '../format-elapsed'

describe('formatElapsed', () => {
  it('formats under an hour as m:ss', () => {
    expect(formatElapsed(0)).toBe('0:00')
    expect(formatElapsed(5000)).toBe('0:05')
    expect(formatElapsed(12000)).toBe('0:12')
    expect(formatElapsed(63000)).toBe('1:03')
    expect(formatElapsed(600000)).toBe('10:00')
  })

  it('formats an hour or more as h:mm:ss', () => {
    expect(formatElapsed(3723000)).toBe('1:02:03')
  })

  it('floors partial seconds', () => {
    expect(formatElapsed(1999)).toBe('0:01')
  })

  it('clamps negatives to 0:00', () => {
    expect(formatElapsed(-500)).toBe('0:00')
  })
})
