import { describe, it, expect, vi } from "vitest"
import { parseProjectRef, createGithubClient } from "../gql-client.js"

describe("parseProjectRef", () => {
  it("passes through a PVT_ node id", () => {
    expect(parseProjectRef("PVT_abc123")).toEqual({ nodeId: "PVT_abc123" })
  })
  it("parses an org project URL", () => {
    expect(parseProjectRef("https://github.com/orgs/boldr/projects/7")).toEqual({
      ownerType: "org", login: "boldr", number: 7,
    })
  })
  it("parses a user project URL", () => {
    expect(parseProjectRef("https://github.com/users/nico/projects/3")).toEqual({
      ownerType: "user", login: "nico", number: 3,
    })
  })
})

describe("createGithubClient.listItems", () => {
  it("maps draft nodes to RemoteItem and paginates", async () => {
    const pages = [
      {
        data: { node: { items: {
          pageInfo: { hasNextPage: true, endCursor: "c1" },
          nodes: [{
            id: "PVTI_1", updatedAt: "2026-01-02T00:00:00Z",
            content: { id: "DI_1", title: "A", body: "ba" },
            fieldValueByName: { optionId: "opt_ip", name: "In progress" },
          }],
        } } },
      },
      {
        data: { node: { items: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [{
            id: "PVTI_2", updatedAt: "2026-01-03T00:00:00Z",
            content: { id: "DI_2", title: "B", body: "" },
            fieldValueByName: null,
          }],
        } } },
      },
    ]
    let call = 0
    const fetchImpl = vi.fn(async () => ({
      ok: true, status: 200, json: async () => pages[call++],
    })) as unknown as typeof fetch
    const client = createGithubClient("tok", fetchImpl)
    const items = await client.listItems("PVT_x")
    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({
      itemId: "PVTI_1", draftId: "DI_1", title: "A", body: "ba", statusOptionId: "opt_ip",
    })
    expect(items[1]).toMatchObject({ itemId: "PVTI_2", statusOptionId: null })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it("throws a clear error on a GraphQL error response", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true, status: 200, json: async () => ({ errors: [{ message: "Bad credentials" }] }),
    })) as unknown as typeof fetch
    const client = createGithubClient("tok", fetchImpl)
    await expect(client.listItems("PVT_x")).rejects.toThrow(/Bad credentials/)
  })
})
