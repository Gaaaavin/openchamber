import { normalizePath } from "@/lib/pathNormalization"
import { opencodeClient } from "@/lib/opencode/client"
import { useDirectoryStore } from "@/stores/useDirectoryStore"
import { useGlobalSessionStatusStore } from "../global-session-status"

type InstanceDisposeClient = {
  instance: {
    dispose: (
      parameters: { directory?: string },
      options: { throwOnError: true },
    ) => Promise<void>
  }
}

type InstanceDisposeDependencies = {
  client: InstanceDisposeClient
  getCurrentDirectory: () => string | null | undefined
  isDirectoryBusy: (directory: string) => boolean
  logFailure: (error: Error) => void
}

const defaultDependencies = (): InstanceDisposeDependencies => ({
  client: {
    instance: {
      dispose: async (parameters, options) => {
        await opencodeClient.getSdkClient().instance.dispose(parameters, options)
      },
    },
  },
  getCurrentDirectory: () => useDirectoryStore.getState().currentDirectory,
  isDirectoryBusy: (directory) => {
    for (const entry of useGlobalSessionStatusStore.getState().statusById.values()) {
      if (entry.directory === directory) return true
    }
    return false
  },
  logFailure: (error: Error) => console.warn("[instance-dispose] Failed to dispose idle OpenCode instance", error),
})

export function disposeIdleOpenCodeInstance(
  directory: string,
  dependencies: InstanceDisposeDependencies = defaultDependencies(),
): void {
  const normalizedDirectory = normalizePath(directory)
  if (!normalizedDirectory) return
  if (normalizePath(dependencies.getCurrentDirectory()) === normalizedDirectory) return
  if (dependencies.isDirectoryBusy(normalizedDirectory)) return

  void dependencies.client.instance
    .dispose({ directory: normalizedDirectory }, { throwOnError: true })
    .catch(dependencies.logFailure)
}
