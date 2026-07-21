/** Cap a per-agent session list to `cap` items while ALWAYS surfacing the active and
 *  any pinned sessions (so the user never loses their place). Preserves input order.
 *  Returns the visible slice + how many are hidden. Pure — unit-tested. */
export function capAgentSessions<T extends { id: string }>(
  sorted: T[],
  opts: { cap: number; activeId?: string | null; isPinned?: (s: T) => boolean },
): { visible: T[]; hiddenCount: number } {
  const { cap, activeId, isPinned } = opts;
  if (sorted.length <= cap) return { visible: sorted, hiddenCount: 0 };
  const mustKeep = new Set<string>();
  for (const s of sorted) {
    if (s.id === activeId) mustKeep.add(s.id);
    if (isPinned?.(s)) mustKeep.add(s.id);
  }
  const visible: T[] = [];
  for (const s of sorted) {
    if (visible.length < cap || mustKeep.has(s.id)) visible.push(s);
  }
  return { visible, hiddenCount: sorted.length - visible.length };
}
