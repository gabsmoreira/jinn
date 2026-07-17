import type { RemoteItem } from "./types.js"

export type FetchImpl = typeof fetch

const GRAPHQL_URL = "https://api.github.com/graphql"

export type ProjectRef =
  | { nodeId: string }
  | { ownerType: "org" | "user"; login: string; number: number }

export function parseProjectRef(urlOrId: string): ProjectRef {
  const s = urlOrId.trim()
  if (s.startsWith("PVT_")) return { nodeId: s }
  const org = s.match(/github\.com\/orgs\/([^/]+)\/projects\/(\d+)/)
  if (org) return { ownerType: "org", login: org[1], number: Number(org[2]) }
  const user = s.match(/github\.com\/users\/([^/]+)\/projects\/(\d+)/)
  if (user) return { ownerType: "user", login: user[1], number: Number(user[2]) }
  throw new Error(`Unrecognized project reference: ${urlOrId}`)
}

export function createGithubClient(token: string, fetchImpl: FetchImpl = fetch) {
  async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const res = await fetchImpl(GRAPHQL_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": "jinn-kanban-sync",
      },
      body: JSON.stringify({ query, variables }),
    })
    if (!res.ok) throw new Error(`GitHub API HTTP ${res.status}`)
    const payload = (await res.json()) as { data?: T; errors?: { message: string }[] }
    if (payload.errors?.length) {
      throw new Error(`GitHub GraphQL error: ${payload.errors.map((e) => e.message).join("; ")}`)
    }
    if (!payload.data) throw new Error("GitHub GraphQL: empty response")
    return payload.data
  }

  async function resolveProject(urlOrId: string) {
    const ref = parseProjectRef(urlOrId)
    let projectId: string
    if ("nodeId" in ref) {
      projectId = ref.nodeId
    } else {
      const q = ref.ownerType === "org"
        ? `query($login:String!,$number:Int!){organization(login:$login){projectV2(number:$number){id}}}`
        : `query($login:String!,$number:Int!){user(login:$login){projectV2(number:$number){id}}}`
      const d = await gql<{ organization?: { projectV2: { id: string } | null }; user?: { projectV2: { id: string } | null } }>(
        q, { login: ref.login, number: ref.number },
      )
      const id = d.organization?.projectV2?.id ?? d.user?.projectV2?.id
      if (!id) throw new Error("Project not found or PAT lacks access")
      projectId = id
    }
    const detail = await gql<{ node: {
      title: string
      field: { id: string; options: { id: string; name: string }[] } | null
    } | null }>(
      `query($id:ID!){node(id:$id){... on ProjectV2{title field(name:"Status"){... on ProjectV2SingleSelectField{id options{id name}}}}}}`,
      { id: projectId },
    )
    if (!detail.node?.field) throw new Error('Project has no "Status" single-select field')
    return {
      projectId,
      title: detail.node.title,
      statusFieldId: detail.node.field.id,
      options: detail.node.field.options,
    }
  }

  async function listItems(projectId: string): Promise<RemoteItem[]> {
    const out: RemoteItem[] = []
    let cursor: string | null = null
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const d: { node: { items: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null }
        nodes: Array<{
          id: string
          updatedAt: string
          content: { id: string; title: string; body: string | null } | null
          fieldValueByName: { optionId: string; name: string } | null
        }>
      } } } = await gql(
        `query($id:ID!,$cursor:String){node(id:$id){... on ProjectV2{items(first:100,after:$cursor){pageInfo{hasNextPage endCursor}nodes{id updatedAt content{... on DraftIssue{id title body}}fieldValueByName(name:"Status"){... on ProjectV2ItemFieldSingleSelectValue{optionId name}}}}}}}`,
        { id: projectId, cursor },
      )
      const items = d.node.items
      for (const n of items.nodes) {
        // Only sync draft issues (skip pulled-in issues/PRs which have no DraftIssue content).
        if (!n.content) continue
        out.push({
          itemId: n.id,
          draftId: n.content.id,
          title: n.content.title,
          body: n.content.body ?? "",
          statusOptionId: n.fieldValueByName?.optionId ?? null,
          updatedAtMs: Date.parse(n.updatedAt) || 0,
        })
      }
      if (!items.pageInfo.hasNextPage) break
      cursor = items.pageInfo.endCursor
    }
    return out
  }

  async function createDraft(projectId: string, title: string, body: string): Promise<string> {
    const d = await gql<{ addProjectV2DraftIssue: { projectItem: { id: string } } }>(
      `mutation($projectId:ID!,$title:String!,$body:String){addProjectV2DraftIssue(input:{projectId:$projectId,title:$title,body:$body}){projectItem{id}}}`,
      { projectId, title, body },
    )
    return d.addProjectV2DraftIssue.projectItem.id
  }

  async function updateDraft(draftId: string, title: string, body: string): Promise<void> {
    await gql(
      `mutation($id:ID!,$title:String!,$body:String){updateProjectV2DraftIssue(input:{draftIssueId:$id,title:$title,body:$body}){draftIssue{id}}}`,
      { id: draftId, title, body },
    )
  }

  async function setStatus(projectId: string, itemId: string, fieldId: string, optionId: string): Promise<void> {
    await gql(
      `mutation($projectId:ID!,$itemId:ID!,$fieldId:ID!,$optionId:String!){updateProjectV2ItemFieldValue(input:{projectId:$projectId,itemId:$itemId,fieldId:$fieldId,value:{singleSelectOptionId:$optionId}}){projectV2Item{id}}}`,
      { projectId, itemId, fieldId, optionId },
    )
  }

  async function deleteItem(projectId: string, itemId: string): Promise<void> {
    await gql(
      `mutation($projectId:ID!,$itemId:ID!){deleteProjectV2Item(input:{projectId:$projectId,itemId:$itemId}){deletedItemId}}`,
      { projectId, itemId },
    )
  }

  return { resolveProject, listItems, createDraft, updateDraft, setStatus, deleteItem }
}

export type GithubClient = ReturnType<typeof createGithubClient>
