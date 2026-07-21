export type TaskLifecycle = "todo" | "running" | "done" | "archived";

/** Derive a task's lifecycle from its status/activity. An explicit `lifecycleState`
 *  (set on the row) always wins — that's how archive (and any manual override) sticks.
 *  Home chats are not tasks; callers should not pass them here. */
export function deriveLifecycleState(s: {
  lifecycleState?: string | null;
  status: string;
  totalTurns: number;
}): TaskLifecycle {
  if (s.lifecycleState === "archived" || s.lifecycleState === "done"
    || s.lifecycleState === "todo" || s.lifecycleState === "running") {
    return s.lifecycleState;
  }
  if (s.status === "running" || s.status === "waiting") return "running";
  return s.totalTurns > 0 ? "done" : "todo";
}

/** A task is archivable when it is a non-home, currently-`done` task whose last
 *  activity is older than `idleDays`. Never archives home chats or live/incomplete work. */
export function isArchiveEligible(
  s: { sessionRole?: string; lifecycleState?: string | null; status: string; totalTurns: number; lastActivity: string },
  nowMs: number,
  idleDays = 7,
): boolean {
  if (s.sessionRole === "home") return false;
  if (s.lifecycleState === "archived") return false;
  if (deriveLifecycleState(s) !== "done") return false;
  const last = Date.parse(s.lastActivity);
  if (Number.isNaN(last)) return false;
  return nowMs - last >= idleDays * 24 * 60 * 60 * 1000;
}
