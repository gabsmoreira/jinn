import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

vi.mock("../../../shared/logger.js", () => ({
  logger: { info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() },
}))

let tmpHome: string
beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-boardio-"))
  process.env.JINN_HOME = tmpHome
  vi.resetModules()
})
afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true })
  delete process.env.JINN_HOME
})

describe("board-io", () => {
  it("returns [] when the board file is missing", async () => {
    const { readBoard } = await import("../board-io.js")
    expect(readBoard("engineering")).toEqual([])
  })
  it("round-trips items through write/read", async () => {
    const { readBoard, writeBoard } = await import("../board-io.js")
    const items = [{
      id: "t1", title: "Task", description: "d", status: "ready", priority: "medium",
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z",
      githubItemId: "PVTI_1", githubSyncedAt: 42,
    }]
    writeBoard("engineering", items)
    expect(readBoard("engineering")).toEqual(items)
  })
})
