/**
 * Format an elapsed duration (milliseconds) as a compact clock:
 *   under an hour → `m:ss` (e.g. "0:12", "1:03")
 *   an hour or more → `h:mm:ss` (e.g. "1:02:03")
 * Partial seconds are floored; negatives clamp to "0:00".
 */
export function formatElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}
