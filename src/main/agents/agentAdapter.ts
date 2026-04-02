import type { AgentAdapter } from '../../types'

export function buildSessionId(source: string, sourceSessionId: string): string {
  return `${source}:${sourceSessionId}`
}

export function normalizePathForKey(pathValue: string): string {
  return pathValue.replace(/\\/g, '/').toLowerCase()
}

export type { AgentAdapter }
