import { describe, expect, test } from "bun:test"
import type { Session } from "@opencode-ai/sdk/v2/client"
import { keepPendingRevert, revertGateStore, runRevertGated } from "./revert-gate"

const session = (id: string, revert?: Session["revert"]): Session => {
  const value: Session = {
    id,
    projectID: "project",
    directory: "/project",
    title: "Session",
    slug: "session",
    version: "1",
    time: { created: 1, updated: 1 },
  }
  if (revert) value.revert = revert
  return value
}

const deferred = () => {
  let resolve: (() => void) | undefined
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve: () => resolve?.() }
}

describe("revert gate", () => {
  test("skips a second call while the session is pending", async () => {
    const wait = deferred()
    let calls = 0
    const first = runRevertGated("session-a", { kind: "revert" }, async () => {
      calls += 1
      await wait.promise
    })

    const second = await runRevertGated("session-a", { kind: "unrevert" }, async () => {
      calls += 1
    })

    expect(second).toEqual({ status: "skipped" })
    expect(calls).toBe(1)
    wait.resolve()
    await first
  })

  test("clears pending after success", async () => {
    await runRevertGated("session-success", { kind: "revert" }, async () => undefined)
    expect(revertGateStore.getState().pending["session-success"]).toEqual(undefined)
  })

  test("clears pending after rejection and propagates the error", async () => {
    const error = new Error("failed")
    await expect(runRevertGated("session-failure", { kind: "revert" }, async () => {
      throw error
    })).rejects.toThrow("failed")
    expect(revertGateStore.getState().pending["session-failure"]).toEqual(undefined)
  })

  test("allows different sessions to run independently", async () => {
    const wait = deferred()
    const first = runRevertGated("session-one", { kind: "revert" }, async () => wait.promise)
    const second = await runRevertGated("session-two", { kind: "unrevert" }, async () => "done")

    expect(second).toEqual({ status: "ran", value: "done" })
    wait.resolve()
    await first
  })

  test("returns the incoming identity when no request is pending", () => {
    const local = session("session-id", { messageID: "local" })
    const incoming = session("session-id", { messageID: "incoming" })
    expect(keepPendingRevert(local, incoming)).toBe(incoming)
  })

  test("preserves a defined local revert marker while pending", async () => {
    const wait = deferred()
    const pending = runRevertGated("session-marker", { kind: "revert" }, async () => wait.promise)
    const local = session("session-marker", { messageID: "local" })
    const incoming = session("session-marker", { messageID: "incoming" })

    expect(keepPendingRevert(local, incoming).revert).toEqual({ messageID: "local" })
    wait.resolve()
    await pending
  })

  test("removes the revert key when the local session has none", async () => {
    const wait = deferred()
    const pending = runRevertGated("session-unrevert", { kind: "unrevert" }, async () => wait.promise)
    const result = keepPendingRevert(
      session("session-unrevert"),
      session("session-unrevert", { messageID: "incoming" }),
    )

    expect("revert" in result).toBe(false)
    wait.resolve()
    await pending
  })

  test("stores the target message id on the pending entry", async () => {
    const wait = deferred()
    const pending = runRevertGated(
      "session-entry",
      { kind: "revert", messageId: "message-target" },
      async () => wait.promise,
    )

    expect(revertGateStore.getState().pending["session-entry"]?.messageId).toBe("message-target")
    wait.resolve()
    await pending
  })
})
