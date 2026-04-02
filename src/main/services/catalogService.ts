import path from 'path'
import type { AgentAdapter, AgentSource, Project, Session, SessionFilter } from '../../types'
import { buildSessionId, normalizePathForKey } from '../agents/agentAdapter'

interface MergedProjectAccumulator {
  key: string
  displayName: string
  resolvedPath: string | null
  sessionCount: number
  lastModified: number
  sources: Set<AgentSource>
  sourceRefs: Project['sourceRefs']
}

function createFallbackKey(source: AgentSource, projectId: string): string {
  return `${source}:${projectId}`
}

function getProjectKey(source: AgentSource, projectId: string, resolvedPath: string | null): string {
  if (resolvedPath) return `path:${normalizePathForKey(resolvedPath)}`
  return createFallbackKey(source, projectId)
}

function pickDisplayName(current: string, candidate: string, resolvedPath: string | null): string {
  if (!resolvedPath) return current || candidate
  const base = path.basename(resolvedPath)
  return base || candidate || current
}

export class CatalogService {
  constructor(private readonly adapters: AgentAdapter[]) {}

  async getProjects(): Promise<Project[]> {
    const allProjects = await Promise.all(this.adapters.map((adapter) => adapter.listProjects()))
    const merged = new Map<string, MergedProjectAccumulator>()

    for (const projects of allProjects) {
      for (const project of projects) {
        if (project.sessionCount <= 0) continue

        const key = getProjectKey(project.source, project.projectId, project.resolvedPath)
        const existing = merged.get(key)

        if (!existing) {
          merged.set(key, {
            key,
            displayName: pickDisplayName(project.displayName, project.displayName, project.resolvedPath),
            resolvedPath: project.resolvedPath,
            sessionCount: project.sessionCount,
            lastModified: project.lastModified,
            sources: new Set([project.source]),
            sourceRefs: [{ source: project.source, projectId: project.projectId }],
          })
          continue
        }

        existing.displayName = pickDisplayName(existing.displayName, project.displayName, existing.resolvedPath ?? project.resolvedPath)
        existing.resolvedPath = existing.resolvedPath ?? project.resolvedPath
        existing.sessionCount += project.sessionCount
        existing.lastModified = Math.max(existing.lastModified, project.lastModified)
        existing.sources.add(project.source)
        existing.sourceRefs.push({ source: project.source, projectId: project.projectId })
      }
    }

    return Array.from(merged.values())
      .filter((project) => project.sessionCount > 0)
      .map((project) => ({
        name: project.key,
        displayName: project.displayName,
        resolvedPath: project.resolvedPath,
        sessionCount: project.sessionCount,
        lastModified: project.lastModified,
        sources: Array.from(project.sources).sort(),
        sourceRefs: project.sourceRefs,
      }))
      .sort((a, b) => b.lastModified - a.lastModified || a.displayName.localeCompare(b.displayName))
  }

  async getSessions(projectKey: string, filter?: SessionFilter): Promise<Session[]> {
    const projects = await this.getProjects()
    const project = projects.find((p) => p.name === projectKey)
    if (!project) return []

    const sessions: Session[] = []

    for (const sourceRef of project.sourceRefs) {
      const adapter = this.adapters.find((candidate) => candidate.source === sourceRef.source)
      if (!adapter) continue
      const sourceSessions = await adapter.listSessions(sourceRef.projectId)

      for (const sourceSession of sourceSessions) {
        sessions.push({
          ...sourceSession,
          id: buildSessionId(sourceRef.source, sourceSession.sourceSessionId),
          source: sourceRef.source,
          sourceDisplayName: adapter.displayName,
          sourceIconSvg: adapter.iconSvg,
          canResume: adapter.supportsResume,
        })
      }
    }

    const filtered = sessions.filter((session) => {
      if (filter?.kinds && filter.kinds.length > 0 && !filter.kinds.includes(session.sessionKind)) return false
      if (filter?.sources && filter.sources.length > 0 && !filter.sources.includes(session.source)) return false
      return true
    })

    return filtered.sort((a, b) => b.mtimeMs - a.mtimeMs)
  }
}
