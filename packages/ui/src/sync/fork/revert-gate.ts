import { useCallback } from "react"
import type { Session } from "@opencode-ai/sdk/v2/client"
import { useStore } from "zustand"
import { createStore } from "zustand/vanilla"

export type RevertPendingEntry = {
  kind: "revert" | "unrevert"
  messageId?: string
  startedAt: number
}

type RevertGateState = {
  pending: Record<string, RevertPendingEntry>
}

type RevertGateResult<T> =
  | { status: "ran"; value: T }
  | { status: "skipped" }

export const revertGateStore = createStore<RevertGateState>(() => ({ pending: {} }))

export async function runRevertGated<T>(
  sessionId: string,
  entry: Omit<RevertPendingEntry, "startedAt">,
  fn: () => Promise<T>,
): Promise<RevertGateResult<T>> {
  if (revertGateStore.getState().pending[sessionId]) return { status: "skipped" }

  const pendingEntry = { ...entry, startedAt: Date.now() }
  revertGateStore.setState((state) => ({
    pending: { ...state.pending, [sessionId]: pendingEntry },
  }))

  try {
    return { status: "ran", value: await fn() }
  } finally {
    revertGateStore.setState((state) => {
      if (state.pending[sessionId] !== pendingEntry) return state
      const pending = { ...state.pending }
      delete pending[sessionId]
      return { pending }
    })
  }
}

/**
 * Wrap a store entrypoint so one revert-family mutation runs per session at a
 * time. Calls that land during the pending window are dropped: the buttons are
 * disabled by then, and a repeated slash command has nothing new to do.
 */
export const gatedRevert = <Rest extends unknown[]>(
  toEntry: (sessionId: string, ...rest: Rest) => Omit<RevertPendingEntry, "startedAt">,
  fn: (sessionId: string, ...rest: Rest) => Promise<void>,
) => async (sessionId: string, ...rest: Rest): Promise<void> => {
  await runRevertGated(sessionId, toEntry(sessionId, ...rest), () => fn(sessionId, ...rest))
}

export function keepPendingRevert(local: Session, incoming: Session): Session {
  if (!revertGateStore.getState().pending[incoming.id]) return incoming

  // While our request is in flight, session.updated predates it; the SDK response or rollback ends the window authoritatively.
  if (local.revert) return { ...incoming, revert: local.revert }
  const withoutRevert = { ...incoming }
  delete withoutRevert.revert
  return withoutRevert
}

export function useRevertPending(sessionId: string | undefined): RevertPendingEntry | undefined {
  const selector = useCallback((state: RevertGateState) => (
    sessionId ? state.pending[sessionId] : undefined
  ), [sessionId])
  return useStore(revertGateStore, selector)
}
