import { describe, expect, test } from "bun:test"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import type { OpencodeClient, Project } from "@opencode-ai/sdk/v2/client"
import { bootstrapDirectory, bootstrapGlobal } from "./bootstrap"
import { INITIAL_STATE, type State } from "./types"

const createSdk = (options?: { commandList?: () => Promise<{ data: unknown[] }>; sessionStatus?: () => Promise<{ data: State['session_status'] }> }) => ({
  project: { current: async () => ({ data: { id: "project-a" } }) },
  config: { get: async () => ({ data: {} }) },
  path: { get: async () => ({ data: { state: "", config: "", worktree: "/repo", directory: "/repo", home: "/home" } }) },
  session: { status: options?.sessionStatus ?? (async () => ({ data: {} })) },
  command: { list: options?.commandList ?? (async () => ({ data: [] })) },
  mcp: { status: async () => ({ data: {} }) },
  lsp: { status: async () => ({ data: [] }) },
  vcs: { get: async () => ({ data: { branch: "main" } }) },
  question: { list: async () => ({ data: [] }) },
  permission: { list: async () => ({ data: [] }) },
}) as unknown as OpencodeClient

const createState = (): State => ({
  ...INITIAL_STATE,
  message: {},
  part: {},
})

const project = { id: "project-a", worktree: "/repo" } as Project

const createRecordingSdk = () => {
  const requests: URL[] = []
  const sdk = createOpencodeClient({
    baseUrl: "https://bootstrap.test",
    fetch: async (request) => {
      const url = new URL(request instanceof Request ? request.url : request.toString())
      requests.push(url)
      const data = url.pathname.endsWith("/project/current")
        ? { id: "project-a" }
        : url.pathname.endsWith("/path")
          ? { state: "", config: "", worktree: "/repo/a", directory: "/repo/a", home: "/home" }
          : url.pathname.endsWith("/project")
            ? []
            : url.pathname.endsWith("/vcs")
              ? { branch: "main" }
              : url.pathname.endsWith("/config") || url.pathname.endsWith("/session/status") || url.pathname.endsWith("/mcp")
                ? {}
                : []
      return new Response(JSON.stringify(data), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    },
  })
  return { requests, sdk }
}

describe("bootstrapDirectory", () => {
  test("scopes every directory bootstrap request", async () => {
    let state = createState()
    const { requests, sdk } = createRecordingSdk()

    expect(await bootstrapDirectory({
      directory: "/repo/a",
      sdk,
      getState: () => state,
      set: (patch) => {
        state = { ...state, ...patch }
      },
      global: { config: {}, projects: [] },
      loadSessions: async () => undefined,
    })).toBe("complete")
    await new Promise((resolve) => setTimeout(resolve, 0))

    for (const suffix of ["/config", "/path", "/session/status", "/project/current", "/command", "/mcp", "/lsp", "/vcs"]) {
      const request = requests.find((url) => url.pathname.endsWith(suffix))
      expect(request?.searchParams.get("directory")).toBe("/repo/a")
    }
  })

  test("prioritizes session loading without waiting for deferred fields", async () => {
    let state = createState()
    let deferredStarted = false
    let resolveDeferred!: () => void
    const deferred = new Promise<{ data: unknown[] }>((resolve) => {
      resolveDeferred = () => resolve({ data: [] })
    })
    let resolveSessions!: () => void
    const sessions = new Promise<void>((resolve) => {
      resolveSessions = resolve
    })
    let settled = false
    const sdk = createSdk({
      commandList: async () => {
        deferredStarted = true
        return deferred
      },
    })
    const bootstrapping = bootstrapDirectory({
      directory: "/repo",
      sdk,
      getState: () => state,
      set: (patch) => {
        state = { ...state, ...patch }
      },
      global: { config: {}, projects: [project] },
      loadSessions: () => sessions,
    }).then((result) => {
      settled = true
      return result
    })

    await Promise.resolve()
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(deferredStarted).toBe(false)
    resolveSessions()

    expect(await bootstrapping).toBe("complete")
    expect(state.status).toBe("complete")
    expect(state.sessionStatusReady).toBe(true)
    expect(deferredStarted).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(deferredStarted).toBe(true)
    resolveDeferred()
  })

  test("reports session-list failure without clearing existing state", async () => {
    let state = { ...createState(), session: [{ id: "cached" }] as State["session"] }
    const result = await bootstrapDirectory({
      directory: "/repo",
      sdk: createSdk(),
      getState: () => state,
      set: (patch) => {
        state = { ...state, ...patch }
      },
      global: { config: {}, projects: [project] },
      loadSessions: async () => {
        throw new Error("unavailable")
      },
    })

    expect(result).toBe("failed")
    expect(state.session.map((session) => session.id)).toEqual(["cached"])
  })

  test("rejects stale work before committing", async () => {
    const state = createState()
    let commits = 0
    const result = await bootstrapDirectory({
      directory: "/repo",
      sdk: createSdk(),
      getState: () => state,
      set: () => {
        commits += 1
      },
      isStale: () => true,
      global: { config: {}, projects: [project] },
      loadSessions: async () => undefined,
    })

    expect(result).toBe("stale")
    expect(commits).toBe(0)
  })

  test("a failed status request cannot grant idle authority even when bootstrap completes", async () => {
    let state = createState()
    const result = await bootstrapDirectory({
      directory: '/repo',
      sdk: createSdk({ sessionStatus: async () => { throw new Error('status unavailable') } }),
      getState: () => state,
      set: (patch) => { state = { ...state, ...patch } },
      global: { config: {}, projects: [project] },
      loadSessions: async () => undefined,
    })
    expect(result).toBe('complete')
    expect(state.sessionStatusReady).toBe(undefined)
  })
})

describe("bootstrapGlobal", () => {
  test("scopes path and project requests when a directory is available", async () => {
    const { requests, sdk } = createRecordingSdk()

    await bootstrapGlobal(sdk, () => undefined, "/repo/a")

    for (const suffix of ["/path", "/project"]) {
      const request = requests.find((url) => url.pathname.endsWith(suffix))
      expect(request?.searchParams.get("directory")).toBe("/repo/a")
    }
  })
})
