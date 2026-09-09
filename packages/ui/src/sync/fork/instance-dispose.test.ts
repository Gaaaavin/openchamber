import { describe, expect, test } from "bun:test"
import { disposeIdleOpenCodeInstance } from "./instance-dispose"

type DisposeCall = [
  parameters: { directory?: string },
  options: { throwOnError: true },
]

const dependencies = (options?: {
  currentDirectory?: string | null
  busy?: boolean
  dispose?: () => Promise<void>
}) => {
  const disposeCalls: DisposeCall[] = []
  const loggedFailures: Error[] = []
  const dispose = async (...args: DisposeCall) => {
    disposeCalls.push(args)
    return options?.dispose?.()
  }
  return {
    dependencies: {
      client: { instance: { dispose } },
      getCurrentDirectory: () => options?.currentDirectory,
      isDirectoryBusy: () => options?.busy ?? false,
      logFailure: (error: Error) => loggedFailures.push(error),
    },
    disposeCalls,
    loggedFailures,
  }
}

const settle = async () => {
  await Promise.resolve()
  await Promise.resolve()
}

describe("disposeIdleOpenCodeInstance", () => {
  test("does not dispose the active directory", () => {
    const setup = dependencies({ currentDirectory: "/repo" })

    disposeIdleOpenCodeInstance("/repo/", setup.dependencies)

    expect(setup.disposeCalls.length).toBe(0)
  })

  test("does not dispose a directory with a busy session", () => {
    const setup = dependencies({ currentDirectory: "/other", busy: true })

    disposeIdleOpenCodeInstance("/repo", setup.dependencies)

    expect(setup.disposeCalls.length).toBe(0)
  })

  test("disposes an idle normalized directory through the injected SDK client", () => {
    const setup = dependencies({ currentDirectory: "/other" })

    disposeIdleOpenCodeInstance("/repo///", setup.dependencies)

    expect(setup.disposeCalls).toEqual([[
      { directory: "/repo" },
      { throwOnError: true },
    ]])
  })

  test("swallows and logs SDK rejection", async () => {
    const error = new Error("dispose failed")
    const setup = dependencies({
      currentDirectory: "/other",
      dispose: async () => {
        throw error
      },
    })

    disposeIdleOpenCodeInstance("/repo", setup.dependencies)
    await settle()

    expect(setup.loggedFailures).toEqual([error])
  })
})
