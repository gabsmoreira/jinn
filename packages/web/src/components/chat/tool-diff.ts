/**
 * Minimal line diff for rendering file-edit hunks in the chat (no dependency).
 * Returns a flat sequence of lines tagged add / del / ctx (context), suitable for
 * a red/green git-style view. An LCS backtrack keeps unchanged lines as context;
 * on a changed block, deletions come before additions.
 */

export type DiffLineType = 'add' | 'del' | 'ctx'
export interface DiffLine {
  type: DiffLineType
  text: string
}

/** Split into lines, ignoring exactly one trailing newline so "a\n" → ["a"]. */
function toLines(text: string): string[] {
  if (text === '') return []
  const body = text.endsWith('\n') ? text.slice(0, -1) : text
  return body.split('\n')
}

// Above this line-count product the O(n·m) LCS table gets expensive; fall back to
// a trivial "remove all, add all" diff (still correct, just not minimal).
const LCS_CELL_BUDGET = 250_000

export function computeLineDiff(oldText: string, newText: string): DiffLine[] {
  const a = toLines(oldText)
  const b = toLines(newText)

  if (a.length === 0) return b.map((text) => ({ type: 'add' as const, text }))
  if (b.length === 0) return a.map((text) => ({ type: 'del' as const, text }))
  if (a.length * b.length > LCS_CELL_BUDGET) {
    return [
      ...a.map((text) => ({ type: 'del' as const, text })),
      ...b.map((text) => ({ type: 'add' as const, text })),
    ]
  }

  // LCS length table.
  const n = a.length
  const m = b.length
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    }
  }

  // Forward backtrack: equal → context; otherwise prefer deletion, then addition,
  // so a changed line renders as "- old" immediately followed by "+ new".
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: 'ctx', text: a[i] })
      i++
      j++
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ type: 'del', text: a[i] })
      i++
    } else {
      out.push({ type: 'add', text: b[j] })
      j++
    }
  }
  while (i < n) out.push({ type: 'del', text: a[i++] })
  while (j < m) out.push({ type: 'add', text: b[j++] })
  return out
}
