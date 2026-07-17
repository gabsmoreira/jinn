/**
 * The fixed 9-column set. Display name == GitHub Status option name (verbatim).
 * Source of truth: docs/superpowers/specs/2026-07-16-github-projects-kanban-sync-design.md.
 * Kept in sync (by hand) with packages/web/src/lib/kanban/types.ts COLUMNS.
 */
export const SLUG_TO_GITHUB_NAME: Record<string, string> = {
  "backlog": "Backlog",
  "ready": "Ready",
  "backlog-week-goal": "Backlog | Week Goal (Onboarding Offline)",
  "in-progress": "In progress",
  "in-review": "In review",
  "backlog-testing": "Backlog | Testing",
  "testing": "Testing",
  "ready-to-release": "Ready to release",
  "done": "Done",
}

export const COLUMN_SLUGS: string[] = Object.keys(SLUG_TO_GITHUB_NAME)

const NORMALIZED_NAME_TO_SLUG = new Map<string, string>(
  Object.entries(SLUG_TO_GITHUB_NAME).map(([slug, name]) => [name.trim().toLowerCase(), slug]),
)

export function githubNameToSlug(name: string): string | undefined {
  return NORMALIZED_NAME_TO_SLUG.get(name.trim().toLowerCase())
}
