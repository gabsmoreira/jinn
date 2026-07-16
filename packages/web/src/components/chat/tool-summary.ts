/**
 * Turn a tool's (possibly truncated) stringified JSON input into a short,
 * human-readable target — e.g. "npm test" for Bash, "chat-sidebar.tsx" for Read.
 * Rendered after the tool name as "Bash · npm test". Returns '' when there's
 * nothing salient to show (the card then shows just the tool name).
 *
 * The gateway truncates tool input to 200 chars, which can cut valid JSON, so we
 * fall back to a lenient field extraction when JSON.parse fails.
 */

const MAX = 60

function clip(value: string): string {
  const oneLine = value.replace(/\s+/g, ' ').trim()
  return oneLine.length > MAX ? `${oneLine.slice(0, MAX)}…` : oneLine
}

function basename(p: string): string {
  const parts = p.split('/').filter(Boolean)
  return parts.length ? parts[parts.length - 1] : p
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** Extract a JSON string field from raw text even if the JSON is truncated/invalid. */
function rawField(raw: string, key: string): string {
  const m = raw.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`))
  if (!m) return ''
  try {
    return JSON.parse(`"${m[1]}"`)
  } catch {
    return m[1]
  }
}

export function summarizeToolInput(toolName: string, inputJson?: string): string {
  if (!inputJson) return ''
  let obj: Record<string, unknown> | undefined
  try {
    const parsed = JSON.parse(inputJson)
    obj = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined
  } catch {
    obj = undefined
  }
  const field = (key: string): string => {
    const v = obj?.[key]
    return typeof v === 'string' ? v : rawField(inputJson, key)
  }

  switch (toolName) {
    case 'Bash':
      return clip(field('command'))
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
    case 'NotebookEdit': {
      const p = field('file_path') || field('path') || field('notebook_path')
      return p ? clip(basename(p)) : ''
    }
    case 'Grep':
    case 'Glob':
      return clip(field('pattern'))
    case 'WebFetch':
    case 'WebSearch': {
      const url = field('url')
      return url ? clip(hostOf(url)) : clip(field('query'))
    }
    case 'Task':
      return clip(field('description'))
    default:
      return ''
  }
}
