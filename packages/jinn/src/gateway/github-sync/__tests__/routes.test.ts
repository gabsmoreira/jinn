import { describe, it, expect } from "vitest"
import { buildStatusOptionIds } from "../connect.js"

describe("buildStatusOptionIds", () => {
  it("matches GitHub options to column slugs by name", () => {
    const { statusOptionIds, unmatchedColumns, unmatchedGithub } = buildStatusOptionIds([
      { id: "o1", name: "Backlog" },
      { id: "o2", name: "In progress" },
      { id: "o3", name: "Done" },
      { id: "o4", name: "Icebox" },
    ])
    expect(statusOptionIds["backlog"]).toBe("o1")
    expect(statusOptionIds["in-progress"]).toBe("o2")
    expect(statusOptionIds["done"]).toBe("o3")
    expect(unmatchedGithub).toContain("Icebox")
    expect(unmatchedColumns).toContain("ready")
  })
})
