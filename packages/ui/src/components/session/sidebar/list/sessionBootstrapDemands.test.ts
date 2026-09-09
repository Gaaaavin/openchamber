import { describe, expect, test } from "bun:test"
import { buildSessionBootstrapDemands } from "./sessionBootstrapDemands"

const sections = [{
  project: { id: "project-a", normalizedPath: "/repo" },
  groups: [
    { id: "root", directory: "/repo", isMain: true },
    { id: "worktree:/repo/wt-a", directory: "/repo/wt-a", isMain: false },
    { id: "worktree:/repo/wt-b", directory: "/repo/wt-b", isMain: false },
  ],
}]

describe("buildSessionBootstrapDemands", () => {
  test("keeps known directories at background priority and ignores worktree groups", () => {
    const input = {
      projectSections: sections,
      knownDirectories: ["/known-project"],
      activeProjectId: null,
      collapsedProjects: new Set(["project-a"]),
      currentDirectory: null,
      currentSessionDirectory: null,
    }
    const demands = buildSessionBootstrapDemands(input)

    expect(demands.map(({ directory, priority }) => [directory, priority])).toEqual([
      ["/known-project", "background"],
      ["/repo", "background"],
    ])
  })

  test("demands a selected session worktree without demanding sibling worktrees", () => {
    const demands = buildSessionBootstrapDemands({
      projectSections: sections,
      activeProjectId: "project-a",
      collapsedProjects: new Set(),
      currentDirectory: "/repo",
      currentSessionDirectory: "/repo/wt-b",
    })
    const byDirectory = new Map(demands.map((demand) => [demand.directory, demand]))

    expect(demands.length).toBe(2)
    expect(byDirectory.get("/repo")?.priority).toBe("selected")
    expect(byDirectory.get("/repo/wt-b")?.priority).toBe("selected")
  })

  test("demands the active project root without a section projection", () => {
    const demands = buildSessionBootstrapDemands({
      activeProjectDirectory: "/repo",
      activeProjectId: "project-a",
      collapsedProjects: new Set(),
      currentDirectory: null,
      currentSessionDirectory: null,
    })

    expect(demands.map(({ directory, priority }) => [directory, priority])).toEqual([
      ["/repo", "active-project"],
    ])
  })
})
