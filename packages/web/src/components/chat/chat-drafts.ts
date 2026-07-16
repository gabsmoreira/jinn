/**
 * Persistent per-chat composer drafts.
 *
 * The chat composer remounts on every session switch (ChatPane is keyed by the
 * session id), so unsent text was lost when switching chats. These helpers stash
 * a draft per session in localStorage — keyed by session id, cleared on send —
 * so switching chats (or reloading the page) restores what you were typing.
 *
 * Storage shape: one key holding `{ [sessionId]: { text, ts } }`. Empty text
 * deletes the entry (send clears the draft). Capped to the most-recent
 * MAX_DRAFTS entries so it can't grow unbounded. All access is best-effort and
 * never throws, so a disabled/quota-full localStorage can't break the composer.
 */

const STORAGE_KEY = 'jinn-chat-drafts'
const NEW_CHAT_KEY = '__new__'
const MAX_DRAFTS = 50

interface DraftEntry {
  text: string
  ts: number
}
type DraftMap = Record<string, DraftEntry>

function keyFor(sessionId: string | null | undefined): string {
  return sessionId || NEW_CHAT_KEY
}

function readAll(): DraftMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    const parsed = raw ? JSON.parse(raw) : {}
    return parsed && typeof parsed === 'object' ? (parsed as DraftMap) : {}
  } catch {
    return {}
  }
}

function writeAll(map: DraftMap): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map))
  } catch {
    /* storage unavailable / quota — drafts are best-effort */
  }
}

/** Restore the draft for a session, or '' if none. */
export function loadDraft(sessionId: string | null | undefined): string {
  return readAll()[keyFor(sessionId)]?.text ?? ''
}

/**
 * Persist a draft for a session. Empty text deletes the entry (used as the
 * clear-on-send path). `now` is injectable for deterministic tests.
 */
export function saveDraft(
  sessionId: string | null | undefined,
  text: string,
  now: number = Date.now(),
): void {
  const map = readAll()
  const key = keyFor(sessionId)
  if (!text) {
    if (!(key in map)) return
    delete map[key]
  } else {
    map[key] = { text, ts: now }
    const keys = Object.keys(map)
    if (keys.length > MAX_DRAFTS) {
      // Evict oldest-first until back under the cap.
      keys.sort((a, b) => (map[a]?.ts ?? 0) - (map[b]?.ts ?? 0))
      for (const stale of keys.slice(0, keys.length - MAX_DRAFTS)) delete map[stale]
    }
  }
  writeAll(map)
}

/** Remove a session's draft (e.g. when the session is deleted). */
export function clearDraft(sessionId: string | null | undefined): void {
  saveDraft(sessionId, '')
}
