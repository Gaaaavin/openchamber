import { useCallback } from "react"
import type { Session } from "@opencode-ai/sdk/v2/client"
import { useStore } from "zustand"
import { createStore } from "zustand/vanilla"
import { showControlMutationWarning } from "./control-mutation-toast"

export type PendingMutationKind = "revert" | "unrevert" | "abort"
type RevertMutationKind = Extract<PendingMutationKind, "revert" | "unrevert">

export type PendingMutationEntry = {
  [Kind in PendingMutationKind]: {
    kind: Kind
    messageId?: string
    startedAt: number
  }
}[PendingMutationKind]

export type RevertPendingEntry = Extract<PendingMutationEntry, { kind: RevertMutationKind }>

type MutationGateState = {
  pending: Record<string, Partial<Record<PendingMutationKind, PendingMutationEntry>>>
}

type MutationGateResult<T> =
  | { status: "ran"; value: T }
  | { status: "skipped" }

// High-latency links need a bound; abort/revert are idempotent, so a client deadline is safe.
export const CONTROL_MUTATION_DEADLINE_MS = 20_000

export const createControlMutationSignal = (deadlineMs = CONTROL_MUTATION_DEADLINE_MS): AbortSignal => (
  AbortSignal.timeout(deadlineMs)
)

export const revertGateStore = createStore<MutationGateState>(() => ({ pending: {} }))

const pendingEntry = (
  state: MutationGateState,
  sessionId: string,
  kind: PendingMutationKind,
): PendingMutationEntry | undefined => state.pending[sessionId]?.[kind]

const hasPending = (
  state: MutationGateState,
  sessionId: string,
  kinds: readonly PendingMutationKind[],
): boolean => kinds.some((kind) => pendingEntry(state, sessionId, kind) !== undefined)

export async function runGated<T>(
  sessionId: string,
  entry: Omit<PendingMutationEntry, "startedAt">,
  fn: (signal: AbortSignal) => Promise<T>,
  deadlineMs = CONTROL_MUTATION_DEADLINE_MS,
): Promise<MutationGateResult<T>> {
  if (pendingEntry(revertGateStore.getState(), sessionId, entry.kind)) return { status: "skipped" }

  const value = { ...entry, startedAt: Date.now() }
  revertGateStore.setState((state) => ({
    pending: {
      ...state.pending,
      [sessionId]: { ...state.pending[sessionId], [entry.kind]: value },
    },
  }))

  try {
    return { status: "ran", value: await fn(createControlMutationSignal(deadlineMs)) }
  } finally {
    revertGateStore.setState((state) => {
      if (pendingEntry(state, sessionId, entry.kind) !== value) return state
      const sessionPending = { ...state.pending[sessionId] }
      delete sessionPending[entry.kind]
      const pending = { ...state.pending }
      if (Object.keys(sessionPending).length === 0) delete pending[sessionId]
      else pending[sessionId] = sessionPending
      return { pending }
    })
  }
}

export async function runRevertGated<T>(
  sessionId: string,
  entry: Omit<RevertPendingEntry, "startedAt">,
  fn: (signal: AbortSignal) => Promise<T>,
  deadlineMs = CONTROL_MUTATION_DEADLINE_MS,
): Promise<MutationGateResult<T>> {
  return runGated(sessionId, entry, fn, deadlineMs)
}

/**
 * Wrap a store entrypoint so one mutation of each revert kind runs per session.
 * Calls that repeat the same kind during its pending window are dropped.
 */
export const gatedRevert = <Rest extends unknown[]>(
  toEntry: (sessionId: string, ...rest: Rest) => Omit<RevertPendingEntry, "startedAt">,
  fn: (sessionId: string, ...rest: [...Rest, AbortSignal]) => Promise<void>,
) => async (sessionId: string, ...rest: Rest): Promise<void> => {
  await runRevertGated(sessionId, toEntry(sessionId, ...rest), async (signal) => {
    try {
      await fn(sessionId, ...rest, signal)
    } catch (error) {
      if (signal.aborted) showControlMutationWarning("revert")
      throw error
    }
  })
}

export function keepPendingRevert(local: Session, incoming: Session): Session {
  if (!hasPending(revertGateStore.getState(), incoming.id, ["revert", "unrevert"])) return incoming

  // While our request is in flight, session.updated predates it; the SDK response or rollback ends the window authoritatively.
  if (local.revert) return { ...incoming, revert: local.revert }
  const withoutRevert = { ...incoming }
  delete withoutRevert.revert
  return withoutRevert
}

export function useRevertPending(sessionId: string | undefined): RevertPendingEntry | undefined {
  const selector = useCallback((state: MutationGateState): RevertPendingEntry | undefined => {
    if (!sessionId) return undefined
    const entry = state.pending[sessionId]?.revert ?? state.pending[sessionId]?.unrevert
    return entry?.kind === "revert" || entry?.kind === "unrevert" ? entry : undefined
  }, [sessionId])
  return useStore(revertGateStore, selector)
}

export function useMutationPending(
  sessionId: string | undefined,
  kind: PendingMutationKind,
): PendingMutationEntry | undefined {
  const selector = useCallback((state: MutationGateState) => (
    sessionId ? pendingEntry(state, sessionId, kind) : undefined
  ), [kind, sessionId])
  return useStore(revertGateStore, selector)
}

export function waitForPending(
  sessionId: string,
  kindOrKinds: PendingMutationKind | readonly PendingMutationKind[],
): Promise<void> {
  const kinds = Array.isArray(kindOrKinds) ? kindOrKinds : [kindOrKinds]
  if (!hasPending(revertGateStore.getState(), sessionId, kinds)) return Promise.resolve()

  return new Promise((resolve) => {
    const unsubscribe = revertGateStore.subscribe((state) => {
      if (hasPending(state, sessionId, kinds)) return
      unsubscribe()
      resolve()
    })
  })
}

export const isControlMutationDeadlineError = (error: Error): boolean => (
  error.name === "TimeoutError" || error.name === "AbortError"
)
