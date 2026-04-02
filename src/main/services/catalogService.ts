import path from 'path'
import type { AgentAdapter, AgentSource, Message, ModelTokenStats, Project, ProjectTokenOverview, Session, SessionFilter } from '../../types'
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

function toNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function aggregateModelTokens(messages: Message[]): ModelTokenStats[] {
  const lastPerMessage = new Map<string, { model: string; usage: NonNullable<NonNullable<Message['message']>['usage']> }>()

  for (const msg of messages) {
    if (msg.type !== 'assistant') continue
    const msgId = msg.message?.id ?? msg.uuid
    const usage = msg.message?.usage
    if (!msgId || !usage) continue

    const usageTotal = toNumber(usage.input_tokens)
      + toNumber(usage.output_tokens)
      + toNumber(usage.cache_creation_input_tokens)
      + toNumber(usage.cache_read_input_tokens)
    if (usageTotal <= 0) continue

    const model = msg.message?.model || 'unknown-model'
    lastPerMessage.set(msgId, { model, usage })
  }

  const modelMap = new Map<string, ModelTokenStats>()
  for (const { model, usage } of lastPerMessage.values()) {
    if (!modelMap.has(model)) {
      modelMap.set(model, {
        model,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      })
    }

    const stats = modelMap.get(model)!
    stats.inputTokens += toNumber(usage.input_tokens)
    stats.outputTokens += toNumber(usage.output_tokens)
    stats.cacheCreationInputTokens += toNumber(usage.cache_creation_input_tokens)
    stats.cacheReadInputTokens += toNumber(usage.cache_read_input_tokens)
  }

  return Array.from(modelMap.values())
}

function totalTokens(stats: ModelTokenStats): number {
  return stats.inputTokens + stats.outputTokens + stats.cacheCreationInputTokens + stats.cacheReadInputTokens
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

  async getProjectTokenOverview(projectKey: string): Promise<ProjectTokenOverview | null> {
    const sessions = await this.getSessions(projectKey)
    if (sessions.length === 0) return null

    const adapterMap = new Map(this.adapters.map((adapter) => [adapter.source, adapter]))
    const perSource = new Map<AgentSource, {
      source: AgentSource
      sourceDisplayName: string
      totalSessions: number
      sessionsWithTokenData: number
      sessionsWithoutTokenData: number
      models: Map<string, ModelTokenStats>
    }>()

    for (const session of sessions) {
      const adapter = adapterMap.get(session.source)
      if (!adapter) continue

      if (!perSource.has(session.source)) {
        perSource.set(session.source, {
          source: session.source,
          sourceDisplayName: adapter.displayName,
          totalSessions: 0,
          sessionsWithTokenData: 0,
          sessionsWithoutTokenData: 0,
          models: new Map(),
        })
      }

      const bucket = perSource.get(session.source)!
      bucket.totalSessions += 1

      if (!session.filePath) {
        bucket.sessionsWithoutTokenData += 1
        continue
      }

      let messages: Message[] = []
      try {
        messages = await adapter.getSessionMessages(session.filePath)
      } catch {
        bucket.sessionsWithoutTokenData += 1
        continue
      }

      const sessionStats = aggregateModelTokens(messages)
      if (sessionStats.length === 0) {
        bucket.sessionsWithoutTokenData += 1
        continue
      }

      bucket.sessionsWithTokenData += 1
      for (const stat of sessionStats) {
        if (!bucket.models.has(stat.model)) {
          bucket.models.set(stat.model, {
            model: stat.model,
            inputTokens: 0,
            outputTokens: 0,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
          })
        }

        const target = bucket.models.get(stat.model)!
        target.inputTokens += stat.inputTokens
        target.outputTokens += stat.outputTokens
        target.cacheCreationInputTokens += stat.cacheCreationInputTokens
        target.cacheReadInputTokens += stat.cacheReadInputTokens
      }
    }

    const agents = Array.from(perSource.values())
      .map((bucket) => ({
        source: bucket.source,
        sourceDisplayName: bucket.sourceDisplayName,
        totalSessions: bucket.totalSessions,
        sessionsWithTokenData: bucket.sessionsWithTokenData,
        sessionsWithoutTokenData: bucket.sessionsWithoutTokenData,
        models: Array.from(bucket.models.values()).sort((a, b) => totalTokens(b) - totalTokens(a) || a.model.localeCompare(b.model)),
      }))
      .sort((a, b) => {
        const aTotal = a.models.reduce((sum, model) => sum + totalTokens(model), 0)
        const bTotal = b.models.reduce((sum, model) => sum + totalTokens(model), 0)
        return bTotal - aTotal || a.sourceDisplayName.localeCompare(b.sourceDisplayName)
      })

    return {
      projectName: projectKey,
      agents,
    }
  }
}
