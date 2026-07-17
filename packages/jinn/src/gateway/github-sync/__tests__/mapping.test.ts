import { describe, it, expect } from "vitest"
import {
  statusOptionIdForItem, slugForOptionId, msOf, resolveConflict,
  applyRemoteToItem, remoteToNewItem,
} from "../mapping.js"
import type { BoardItem, RemoteItem } from "../types.js"

const OPTS = { "in-progress": "opt_ip", "done": "opt_done", "backlog": "opt_bk" }

const baseItem: BoardItem = {
  id: "t1", title: "T", description: "body", status: "in-progress", priority: "medium",
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z",
  githubItemId: "PVTI_1", githubSyncedAt: msOf("2026-01-02T00:00:00.000Z"),
}
const baseRemote: RemoteItem = {
  itemId: "PVTI_1", draftId: "DI_1", title: "T", body: "body",
  statusOptionId: "opt_ip", updatedAtMs: msOf("2026-01-02T00:00:00.000Z"), assignee: null,
}

describe("mapping", () => {
  it("maps slug to option id and back", () => {
    expect(statusOptionIdForItem(baseItem, OPTS)).toBe("opt_ip")
    expect(slugForOptionId("opt_done", OPTS)).toBe("done")
    expect(slugForOptionId("unknown", OPTS)).toBe("backlog")
    expect(slugForOptionId(null, OPTS)).toBe("backlog")
  })
  it("resolveConflict: only-local change pushes", () => {
    const item = { ...baseItem, updatedAt: "2026-01-03T00:00:00.000Z" }
    expect(resolveConflict(item, baseRemote, item.githubSyncedAt!)).toBe("push")
  })
  it("resolveConflict: only-remote change pulls", () => {
    const remote = { ...baseRemote, updatedAtMs: msOf("2026-01-05T00:00:00.000Z") }
    expect(resolveConflict(baseItem, remote, baseItem.githubSyncedAt!)).toBe("pull")
  })
  it("resolveConflict: both changed → newer wins", () => {
    const item = { ...baseItem, updatedAt: "2026-01-04T00:00:00.000Z" }
    const remote = { ...baseRemote, updatedAtMs: msOf("2026-01-06T00:00:00.000Z") }
    expect(resolveConflict(item, remote, baseItem.githubSyncedAt!)).toBe("pull")
    const remote2 = { ...baseRemote, updatedAtMs: msOf("2026-01-03T00:00:00.000Z") }
    expect(resolveConflict(item, remote2, baseItem.githubSyncedAt!)).toBe("push")
  })
  it("resolveConflict: both changed with tie → favors push", () => {
    const item = { ...baseItem, updatedAt: "2026-01-04T00:00:00.000Z" }
    const remote = { ...baseRemote, updatedAtMs: msOf("2026-01-04T00:00:00.000Z") }
    expect(resolveConflict(item, remote, baseItem.githubSyncedAt!)).toBe("push")
  })
  it("resolveConflict: neither changed → noop", () => {
    expect(resolveConflict(baseItem, baseRemote, baseItem.githubSyncedAt!)).toBe("noop")
  })
  it("applyRemoteToItem copies title/body/status", () => {
    const remote = { ...baseRemote, title: "New", body: "nb", statusOptionId: "opt_done" }
    const out = applyRemoteToItem(baseItem, remote, OPTS, "2026-02-01T00:00:00.000Z")
    expect(out.title).toBe("New")
    expect(out.description).toBe("nb")
    expect(out.status).toBe("done")
    expect(out.updatedAt).toBe("2026-02-01T00:00:00.000Z")
    expect(out.id).toBe("t1")
  })
  it("applyRemoteToItem surfaces the GitHub assignee but never wipes a local one", () => {
    const noAssignee = { ...baseItem, assignee: "employee-alice" }
    // GitHub has an assignee → it wins (display-only source of truth)
    const withRemote = applyRemoteToItem(noAssignee, { ...baseRemote, assignee: "octocat" }, OPTS, "2026-02-01T00:00:00.000Z")
    expect(withRemote.assignee).toBe("octocat")
    // GitHub has none → keep the existing local assignee rather than clearing it
    const withoutRemote = applyRemoteToItem(noAssignee, { ...baseRemote, assignee: null }, OPTS, "2026-02-01T00:00:00.000Z")
    expect(withoutRemote.assignee).toBe("employee-alice")
  })
  it("remoteToNewItem builds a fresh backlog-fallback item and carries the assignee", () => {
    const remote = { ...baseRemote, statusOptionId: "opt_weird", assignee: "octocat" }
    const out = remoteToNewItem(remote, OPTS, "newid", "2026-02-01T00:00:00.000Z")
    expect(out.id).toBe("newid")
    expect(out.status).toBe("backlog")
    expect(out.githubItemId).toBe("PVTI_1")
    expect(out.priority).toBe("medium")
    expect(out.githubSyncedAt).toBe(msOf("2026-02-01T00:00:00.000Z"))
    expect(out.assignee).toBe("octocat")
  })
})
