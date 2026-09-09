import type { DirectoryBootstrapDemand, DirectoryBootstrapPriority } from "@/sync/child-store"
import { normalizePath } from "../utils"

type BootstrapProjectSection = {
  project: { id: string; normalizedPath: string }
}

const PRIORITY_RANK = {
  selected: 0,
  "active-project": 1,
  expanded: 2,
  visible: 3,
  background: 4,
} satisfies Record<DirectoryBootstrapPriority, number>

export function buildSessionBootstrapDemands(input: {
  projectSections?: BootstrapProjectSection[]
  knownDirectories?: Iterable<string>
  activeProjectDirectory?: string | null
  activeProjectId: string | null
  collapsedProjects: ReadonlySet<string>
  currentDirectory: string | null
  currentSessionDirectory: string | null
}): DirectoryBootstrapDemand[] {
  const byDirectory = new Map<string, DirectoryBootstrapDemand>()
  const add = (
    directory: string | null | undefined,
    priority: DirectoryBootstrapPriority,
    reason: DirectoryBootstrapDemand["reason"],
  ) => {
    const normalizedDirectory = normalizePath(directory ?? null)
    if (!normalizedDirectory) return
    const existing = byDirectory.get(normalizedDirectory)
    if (existing && PRIORITY_RANK[existing.priority] <= PRIORITY_RANK[priority]) return
    byDirectory.set(normalizedDirectory, { directory: normalizedDirectory, priority, reason })
  }

  for (const directory of input.knownDirectories ?? []) {
    add(directory, "background", "known-project")
  }
  add(input.activeProjectDirectory, "active-project", "project-expanded")

  for (const section of input.projectSections ?? []) {
    const projectExpanded = !input.collapsedProjects.has(section.project.id)
    let projectPriority: DirectoryBootstrapPriority = "background"
    if (section.project.id === input.activeProjectId) {
      projectPriority = "active-project"
    } else if (projectExpanded) {
      projectPriority = "expanded"
    }
    add(
      section.project.normalizedPath,
      projectPriority,
      projectExpanded ? "project-expanded" : "known-project",
    )

    // FORK: Bootstrap worktrees only when their session is selected; every directory costs an OpenCode instance.
  }

  add(input.currentDirectory, "selected", "current-directory")
  add(input.currentSessionDirectory, "selected", "selected-session")
  return [...byDirectory.values()]
}
