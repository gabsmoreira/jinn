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
