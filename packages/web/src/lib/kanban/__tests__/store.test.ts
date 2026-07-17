import { describe, it, expect } from "vitest"
import { loadTickets, saveTickets } from "../store"

// jsdom provides localStorage in the web vitest env.
describe("sanitizeTicket status migration", () => {
  it("migrates legacy statuses to the new 9-column slugs", () => {
    localStorage.setItem("jinn-kanban", JSON.stringify({
      a: { title: "A", status: "todo", priority: "medium", createdAt: 1, updatedAt: 2 },
      b: { title: "B", status: "review", priority: "high", createdAt: 1, updatedAt: 2 },
      c: { title: "C", status: "in-progress", priority: "low", createdAt: 1, updatedAt: 2 },
      d: { title: "D", status: "nonsense", priority: "medium", createdAt: 1, updatedAt: 2 },
    }))
    const store = loadTickets()
    expect(store.a.status).toBe("ready")
    expect(store.b.status).toBe("in-review")
    expect(store.c.status).toBe("in-progress")
    expect(store.d.status).toBe("backlog")
  })

  it("preserves githubItemId and githubSyncedAt through a round-trip", () => {
    saveTickets({
      x: {
        id: "x", title: "X", description: "", status: "done", priority: "medium",
        assigneeId: null, department: null, workState: "idle",
        createdAt: 1, updatedAt: 2, departmentId: null,
        githubItemId: "PVTI_abc", githubSyncedAt: 999,
      },
    })
    const store = loadTickets()
    expect(store.x.githubItemId).toBe("PVTI_abc")
    expect(store.x.githubSyncedAt).toBe(999)
  })
})
