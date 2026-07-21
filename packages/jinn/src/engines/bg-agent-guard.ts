/** Claude Code 2.1.x prints this when `--resume` hits a session its agent daemon
 *  holds as a background agent: "Session <id> is currently running as a background
 *  agent (bg). Use `claude agents` … or add --fork-session …". Match a stable
 *  substring so wording/id around it doesn't matter. */
export const BG_AGENT_MARKER = "running as a background agent";

export function isBgAgentRefusal(text: string): boolean {
  return text.includes(BG_AGENT_MARKER);
}

/** Fast-exit circuit breaker: if a session's PTY keeps dying almost immediately,
 *  stop respawning (backstop for any immediate-exit loop, not just bg-agent). */
export const FAST_EXIT_MS = 4000;
export const FAST_EXIT_LIMIT = 3;

export interface ExitRecord {
  count: number;
}

/** Fold one PTY exit into the record. `livedMs` = exit time − spawn time. A PTY that
 *  lived past `fastMs` resets the streak; otherwise the streak grows and trips at
 *  `limit`. Pure — the caller holds one record per session. */
export function registerExit(
  prev: ExitRecord | undefined,
  livedMs: number,
  opts?: { fastMs?: number; limit?: number },
): { record: ExitRecord; tripped: boolean } {
  const fastMs = opts?.fastMs ?? FAST_EXIT_MS;
  const limit = opts?.limit ?? FAST_EXIT_LIMIT;
  if (livedMs >= fastMs) return { record: { count: 0 }, tripped: false };
  const count = (prev?.count ?? 0) + 1;
  return { record: { count }, tripped: count >= limit };
}
