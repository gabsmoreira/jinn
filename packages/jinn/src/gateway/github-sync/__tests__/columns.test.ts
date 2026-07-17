import { describe, it, expect } from "vitest"
import { COLUMN_SLUGS, SLUG_TO_GITHUB_NAME, githubNameToSlug } from "../columns.js"

describe("columns", () => {
  it("has 9 ordered slugs", () => {
    expect(COLUMN_SLUGS).toEqual([
      "backlog", "ready", "backlog-week-goal", "in-progress", "in-review",
      "backlog-testing", "testing", "ready-to-release", "done",
    ])
  })
  it("maps slug to exact GitHub name", () => {
    expect(SLUG_TO_GITHUB_NAME["backlog-week-goal"]).toBe("Backlog | Week Goal (Onboarding Offline)")
    expect(SLUG_TO_GITHUB_NAME["in-progress"]).toBe("In progress")
  })
  it("resolves GitHub name to slug case-insensitively", () => {
    expect(githubNameToSlug("In Progress")).toBe("in-progress")
    expect(githubNameToSlug("  Ready to release ")).toBe("ready-to-release")
    expect(githubNameToSlug("Unknown Column")).toBeUndefined()
  })
})
