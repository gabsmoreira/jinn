import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

vi.mock("../../../shared/logger.js", () => ({
  logger: { info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() },
}))

let tmpHome: string
beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-engine-"))
  process.env.JINN_HOME = tmpHome
  vi.resetModules()
})
afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true })
  delete process.env.JINN_HOME
})

const github = {
  token: "tok", projectId: "PVT_x", department: "engineering",
  statusFieldId: "F_status",
  statusOptionIds: { "in-progress": "opt_ip", "done": "opt_done", "backlog": "opt_bk" },
  enabled: true,
}

function fakeClient(overrides: Partial<Record<string, any>> = {}) {
  return {
    resolveProject: vi.fn(),
    listItems: vi.fn(async () => [] as any[]),
    createDraft: vi.fn(async () => "PVTI_new"),
    updateDraft: vi.fn(async () => {}),
    setStatus: vi.fn(async () => {}),
    deleteItem: vi.fn(async () => {}),
    ...overrides,
  }
}

describe("reconcile", () => {
  it("creates a draft for a local-only ticket and stores its item id", async () => {
    const { writeBoard, readBoard } = await import("../board-io.js")
    const { reconcile } = await import("../engine.js")
    writeBoard("engineering", [{
      id: "t1", title: "New task", description: "d", status: "in-progress", priority: "medium",
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    }])
    const client = fakeClient()
    const summary = await reconcile({ client: client as any, github, nowIso: "2026-02-01T00:00:00.000Z", newId: () => "gen" })
    expect(client.createDraft).toHaveBeenCalledWith("PVT_x", "New task", "d")
    expect(client.setStatus).toHaveBeenCalledWith("PVT_x", "PVTI_new", "F_status", "opt_ip")
    expect(summary.created).toBe(1)
    const board = readBoard("engineering")
    expect(board[0].githubItemId).toBe("PVTI_new")
    expect(board[0].githubSyncedAt).toBe(Date.parse("2026-02-01T00:00:00.000Z"))
  })

  it("imports a remote-only draft as a new local ticket", async () => {
    const { readBoard } = await import("../board-io.js")
    const { reconcile } = await import("../engine.js")
    const client = fakeClient({
      listItems: vi.fn(async () => [{
        itemId: "PVTI_r", draftId: "DI_r", title: "Remote", body: "rb",
        statusOptionId: "opt_done", updatedAtMs: Date.parse("2026-01-05T00:00:00Z"),
      }]),
    })
    const summary = await reconcile({ client: client as any, github, nowIso: "2026-02-01T00:00:00.000Z", newId: () => "imported1" })
    expect(summary.imported).toBe(1)
    const board = readBoard("engineering")
    expect(board[0]).toMatchObject({ id: "imported1", title: "Remote", status: "done", githubItemId: "PVTI_r" })
  })

  it("does not re-import a tombstoned remote item", async () => {
    const { saveSyncState } = await import("../sync-state.js")
    const { readBoard } = await import("../board-io.js")
    const { reconcile } = await import("../engine.js")
    saveSyncState({ linkedItemIds: [], deletedItemIds: ["PVTI_r"], lastPollAt: null, lastError: null })
    const client = fakeClient({
      listItems: vi.fn(async () => [{
        itemId: "PVTI_r", draftId: "DI_r", title: "Remote", body: "",
        statusOptionId: null, updatedAtMs: Date.parse("2026-01-05T00:00:00Z"),
      }]),
    })
    const summary = await reconcile({ client: client as any, github, nowIso: "2026-02-01T00:00:00.000Z", newId: () => "x" })
    expect(summary.imported).toBe(0)
    expect(readBoard("engineering")).toEqual([])
  })

  it("deletes on GitHub (not re-imports) when a previously-linked ticket was removed locally", async () => {
    // A ticket was linked to PVTI_r before, but the local board no longer has it
    // (user deleted it in Jinn). The remote item still exists → delete on GitHub.
    const { saveSyncState, loadSyncState } = await import("../sync-state.js")
    const { readBoard } = await import("../board-io.js")
    const { reconcile } = await import("../engine.js")
    saveSyncState({ linkedItemIds: ["PVTI_r"], deletedItemIds: [], lastPollAt: null, lastError: null })
    const client = fakeClient({
      listItems: vi.fn(async () => [{
        itemId: "PVTI_r", draftId: "DI_r", title: "Remote", body: "",
        statusOptionId: null, updatedAtMs: Date.parse("2026-01-05T00:00:00Z"),
      }]),
    })
    const summary = await reconcile({ client: client as any, github, nowIso: "2026-02-01T00:00:00.000Z", newId: () => "x" })
    expect(client.deleteItem).toHaveBeenCalledWith("PVT_x", "PVTI_r")
    expect(summary.imported).toBe(0)
    expect(summary.deleted).toBe(1)
    expect(readBoard("engineering")).toEqual([])
    expect(loadSyncState().deletedItemIds).toContain("PVTI_r")
  })

  it("deletes a linked local ticket that vanished from GitHub", async () => {
    const { writeBoard, readBoard } = await import("../board-io.js")
    const { reconcile } = await import("../engine.js")
    writeBoard("engineering", [{
      id: "t1", title: "Linked", description: "", status: "done", priority: "medium",
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
      githubItemId: "PVTI_gone", githubSyncedAt: Date.parse("2026-01-01T00:00:00Z"),
    }])
    const client = fakeClient({ listItems: vi.fn(async () => []) })
    const summary = await reconcile({ client: client as any, github, nowIso: "2026-02-01T00:00:00.000Z", newId: () => "x" })
    expect(summary.deleted).toBe(1)
    expect(readBoard("engineering")).toEqual([])
  })

  it("records lastError, rethrows nothing, and preserves prior sync state when the client fails immediately", async () => {
    const { saveSyncState, loadSyncState } = await import("../sync-state.js")
    const { writeBoard } = await import("../board-io.js")
    const { reconcile } = await import("../engine.js")
    writeBoard("engineering", [{
      id: "t1", title: "Linked", description: "", status: "done", priority: "medium",
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
      githubItemId: "PVTI_a", githubSyncedAt: Date.parse("2026-01-01T00:00:00Z"),
    }])
    saveSyncState({ linkedItemIds: ["PVTI_a"], deletedItemIds: ["PVTI_b"], lastPollAt: 123, lastError: null })
    const client = fakeClient({ listItems: vi.fn(async () => { throw new Error("boom") }) })
    const summary = await reconcile({ client: client as any, github, nowIso: "2026-02-01T00:00:00.000Z", newId: () => "x" })
    expect(summary.error).toMatch(/boom/)
    const state = loadSyncState()
    expect(state.lastError).toMatch(/boom/)
    expect(state.linkedItemIds).toEqual(["PVTI_a"])
    expect(state.deletedItemIds).toEqual(["PVTI_b"])
  })

  it("pushes local changes to GitHub when the local ticket is newer and remote is unchanged", async () => {
    const { writeBoard, readBoard } = await import("../board-io.js")
    const { reconcile } = await import("../engine.js")
    writeBoard("engineering", [{
      id: "t1", title: "Local Title", description: "d", status: "in-progress", priority: "medium",
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-10T00:00:00.000Z",
      githubItemId: "PVTI_x", githubSyncedAt: Date.parse("2026-01-05T00:00:00.000Z"),
    }])
    const client = fakeClient({
      listItems: vi.fn(async () => [{
        itemId: "PVTI_x", draftId: "DI_x", title: "Remote Title", body: "rb",
        statusOptionId: "opt_done", updatedAtMs: Date.parse("2026-01-02T00:00:00Z"),
      }]),
    })
    const summary = await reconcile({ client: client as any, github, nowIso: "2026-02-01T00:00:00.000Z", newId: () => "x" })
    expect(client.updateDraft).toHaveBeenCalledWith("DI_x", "Local Title", "d")
    expect(client.setStatus).toHaveBeenCalledWith("PVT_x", "PVTI_x", "F_status", "opt_ip")
    expect(summary.updated).toBe(1)
    const board = readBoard("engineering")
    expect(board[0].title).toBe("Local Title")
    expect(board[0].githubSyncedAt).toBe(Date.parse("2026-02-01T00:00:00.000Z"))
  })

  it("pulls remote changes into the local ticket when remote is newer", async () => {
    const { writeBoard, readBoard } = await import("../board-io.js")
    const { reconcile } = await import("../engine.js")
    writeBoard("engineering", [{
      id: "t1", title: "Local Title", description: "d", status: "in-progress", priority: "medium",
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z",
      githubItemId: "PVTI_x", githubSyncedAt: Date.parse("2026-01-05T00:00:00.000Z"),
    }])
    const client = fakeClient({
      listItems: vi.fn(async () => [{
        itemId: "PVTI_x", draftId: "DI_x", title: "Remote Title", body: "rb",
        statusOptionId: "opt_done", updatedAtMs: Date.parse("2026-01-10T00:00:00Z"),
      }]),
    })
    const summary = await reconcile({ client: client as any, github, nowIso: "2026-02-01T00:00:00.000Z", newId: () => "x" })
    expect(client.updateDraft).not.toHaveBeenCalled()
    expect(client.setStatus).not.toHaveBeenCalled()
    expect(client.createDraft).not.toHaveBeenCalled()
    expect(summary.updated).toBe(1)
    const board = readBoard("engineering")
    expect(board[0].title).toBe("Remote Title")
    expect(board[0].status).toBe("done")
  })

  it("does not lose or recreate a successfully-created draft when a later call fails mid-reconcile", async () => {
    const { writeBoard, readBoard } = await import("../board-io.js")
    const { reconcile } = await import("../engine.js")
    writeBoard("engineering", [
      {
        id: "t1", title: "First", description: "", status: "backlog", priority: "medium",
        createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "t2", title: "Second", description: "", status: "backlog", priority: "medium",
        createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ])
    const client = fakeClient({
      createDraft: vi.fn(async (_projectId: string, title: string) => {
        if (title === "First") return "PVTI_first"
        throw new Error("rate limited")
      }),
    })
    const summary1 = await reconcile({ client: client as any, github, nowIso: "2026-02-01T00:00:00.000Z", newId: () => "x" })
    expect(summary1.error).toMatch(/rate limited/)
    const boardAfterFailure = readBoard("engineering")
    expect(boardAfterFailure).toHaveLength(2)
    const first = boardAfterFailure.find((b) => b.id === "t1")
    const second = boardAfterFailure.find((b) => b.id === "t2")
    expect(first?.githubItemId).toBe("PVTI_first")
    expect(second?.githubItemId).toBeUndefined()

    // Second reconcile: GitHub now knows about "First" (matched by itemId) and
    // createDraft resolves — only the still-unlinked "Second" should be created.
    client.listItems = vi.fn(async () => [{
      itemId: "PVTI_first", draftId: "DI_first", title: "First", body: "",
      statusOptionId: null, updatedAtMs: Date.parse("2026-01-01T00:00:00Z"),
    }])
    client.createDraft = vi.fn(async () => "PVTI_second")
    const summary2 = await reconcile({ client: client as any, github, nowIso: "2026-02-02T00:00:00.000Z", newId: () => "y" })
    expect(summary2.error).toBeUndefined()
    expect(client.createDraft).toHaveBeenCalledTimes(1)
    expect(client.createDraft).toHaveBeenCalledWith("PVT_x", "Second", "")
  })
})
