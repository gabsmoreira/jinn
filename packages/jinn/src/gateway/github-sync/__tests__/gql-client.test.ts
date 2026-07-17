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
            content: { id: "DI_1", title: "A", body: "ba", assignees: { nodes: [{ login: "octocat" }, { login: "hubber" }] } },
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
      assignee: "octocat, hubber",
    })
    expect(items[1]).toMatchObject({ itemId: "PVTI_2", statusOptionId: null, assignee: null })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it("throws a clear error on a GraphQL error response", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true, status: 200, json: async () => ({ errors: [{ message: "Bad credentials" }] }),
    })) as unknown as typeof fetch
    const client = createGithubClient("tok", fetchImpl)
    await expect(client.listItems("PVT_x")).rejects.toThrow(/Bad credentials/)
  })

  it("skips items with null content (non-draft issues/PRs)", async () => {
    const page = {
      data: { node: { items: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [
          {
            id: "PVTI_10", updatedAt: "2026-01-04T00:00:00Z",
            content: null,
            fieldValueByName: null,
          },
          {
            id: "PVTI_11", updatedAt: "2026-01-05T00:00:00Z",
            content: { id: "DI_11", title: "Draft", body: "b" },
            fieldValueByName: { optionId: "opt_1", name: "Todo" },
          },
        ],
      } } },
    }
    const fetchImpl = vi.fn(async () => ({
      ok: true, status: 200, json: async () => page,
    })) as unknown as typeof fetch
    const client = createGithubClient("tok", fetchImpl)
    const items = await client.listItems("PVT_x")
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ itemId: "PVTI_11", draftId: "DI_11" })
  })
})

describe("createGithubClient mutations", () => {
  function bodyOf(fetchImpl: ReturnType<typeof vi.fn>, callIndex = 0): { query: string; variables: Record<string, unknown> } {
    const [, init] = fetchImpl.mock.calls[callIndex] as [string, { body: string }]
    return JSON.parse(init.body)
  }

  it("createDraft sends addProjectV2DraftIssue and returns the projectItem id", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({ data: { addProjectV2DraftIssue: { projectItem: { id: "PVTI_new" } } } }),
    })) as unknown as ReturnType<typeof vi.fn>
    const client = createGithubClient("tok", fetchImpl as unknown as typeof fetch)
    const id = await client.createDraft("PVT_x", "Title", "Body")
    expect(id).toBe("PVTI_new")
    const { query, variables } = bodyOf(fetchImpl)
    expect(query).toContain("addProjectV2DraftIssue")
    expect(variables).toEqual({ projectId: "PVT_x", title: "Title", body: "Body" })
  })

  it("setStatus sends updateProjectV2ItemFieldValue with singleSelectOptionId", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: "PVTI_1" } } } }),
    })) as unknown as ReturnType<typeof vi.fn>
    const client = createGithubClient("tok", fetchImpl as unknown as typeof fetch)
    await client.setStatus("PVT_x", "PVTI_1", "FIELD_1", "OPT_1")
    const { query, variables } = bodyOf(fetchImpl)
    expect(query).toContain("updateProjectV2ItemFieldValue")
    expect(query).toContain("singleSelectOptionId")
    expect(variables).toEqual({ projectId: "PVT_x", itemId: "PVTI_1", fieldId: "FIELD_1", optionId: "OPT_1" })
  })

  it("deleteItem sends deleteProjectV2Item with projectId and itemId", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({ data: { deleteProjectV2Item: { deletedItemId: "PVTI_1" } } }),
    })) as unknown as ReturnType<typeof vi.fn>
    const client = createGithubClient("tok", fetchImpl as unknown as typeof fetch)
    await client.deleteItem("PVT_x", "PVTI_1")
    const { query, variables } = bodyOf(fetchImpl)
    expect(query).toContain("deleteProjectV2Item")
    expect(variables).toEqual({ projectId: "PVT_x", itemId: "PVTI_1" })
  })
})

describe("createGithubClient.resolveProject", () => {
  it("throws a friendly error (not a TypeError) when projectV2 is null", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({ data: { organization: { projectV2: null } } }),
    })) as unknown as typeof fetch
    const client = createGithubClient("tok", fetchImpl)
    await expect(client.resolveProject("https://github.com/orgs/boldr/projects/999"))
      .rejects.toThrow(/Project not found or PAT lacks access/)
  })
})
