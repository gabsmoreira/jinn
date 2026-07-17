import { COLUMN_SLUGS, githubNameToSlug } from "./columns.js"

export function buildStatusOptionIds(options: { id: string; name: string }[]): {
  statusOptionIds: Record<string, string>
  unmatchedColumns: string[]
  unmatchedGithub: string[]
} {
  const statusOptionIds: Record<string, string> = {}
  const unmatchedGithub: string[] = []
  for (const opt of options) {
    const slug = githubNameToSlug(opt.name)
    if (slug) statusOptionIds[slug] = opt.id
    else unmatchedGithub.push(opt.name)
  }
  const unmatchedColumns = COLUMN_SLUGS.filter((slug) => !(slug in statusOptionIds))
  return { statusOptionIds, unmatchedColumns, unmatchedGithub }
}
