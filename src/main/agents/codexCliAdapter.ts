import fs from 'fs'
import os from 'os'
import path from 'path'
import type { AgentAdapter, AgentProject, AgentSession, ContentBlock, Message } from '../../types'
import { normalizePathForKey } from './agentAdapter'
import { launchDetached } from '../platform'

const CODEX_DIR = path.join(os.homedir(), '.codex')
const CODEX_SESSIONS_DIR = path.join(CODEX_DIR, 'sessions')
const CODEX_CONFIG_TOML_PATH = path.join(CODEX_DIR, 'config.toml')
const CODEX_ICON_SVG = '<svg fill="currentColor" fill-rule="evenodd" height="1em" style="flex:none;line-height:1" viewBox="0 0 24 24" width="1em" xmlns="http://www.w3.org/2000/svg"><title>Codex CLI</title><path d="M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z"></path></svg>'

interface CodexSessionHeader {
  sourceSessionId: string
  cwd: string | null
  timestamp: string | null
  summary: string | null
}

interface CodexTokenUsage {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

const CODEX_FALLBACK_MODEL = 'gpt-?.?-codex'

let cachedCodexConfiguredModel: string | null | undefined

function parseCodexConfigModel(content: string): string | null {
  const lines = content.split(/\r?\n/)

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue

    const match = line.match(/^model\s*=\s*(?:"([^"]+)"|'([^']+)'|([^#\s]+))/)
    const value = match?.[1] ?? match?.[2] ?? match?.[3]
    if (value && value.trim().length > 0) return value.trim()
  }

  return null
}

function getConfiguredCodexModel(): string | null {
  if (cachedCodexConfiguredModel !== undefined) return cachedCodexConfiguredModel

  try {
    if (!fs.existsSync(CODEX_CONFIG_TOML_PATH)) {
      cachedCodexConfiguredModel = null
      return cachedCodexConfiguredModel
    }

    const configContent = fs.readFileSync(CODEX_CONFIG_TOML_PATH, 'utf8')
    cachedCodexConfiguredModel = parseCodexConfigModel(configContent)
    return cachedCodexConfiguredModel
  } catch {
    cachedCodexConfiguredModel = null
    return cachedCodexConfiguredModel
  }
}

function collectJsonlFiles(rootDir: string): string[] {
  if (!fs.existsSync(rootDir)) return []
  const results: string[] = []

  function walk(dirPath: string): void {
    let entries: fs.Dirent[] = []
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name)
      if (entry.isDirectory()) {
        walk(fullPath)
        continue
      }
      if (entry.isFile() && entry.name.endsWith('.jsonl')) results.push(fullPath)
    }
  }

  walk(rootDir)
  return results
}

function parseRoleContent(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''

  const parts: string[] = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const value = block as { text?: unknown; type?: unknown }
    if (typeof value.text === 'string' && value.text.trim().length > 0) {
      parts.push(value.text.trim())
      continue
    }
    if (value.type === 'text' && typeof value.text === 'string' && value.text.trim().length > 0) {
      parts.push(value.text.trim())
    }
  }
  return parts.join('\n')
}

function normalizeUserText(raw: string): string {
  const stripped = raw
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/gi, '')
    .replace(/<environment_info>[\s\S]*?<\/environment_info>/gi, '')
    .replace(/<workspace_info>[\s\S]*?<\/workspace_info>/gi, '')
    .replace(/<userMemory>[\s\S]*?<\/userMemory>/gi, '')
    .replace(/<sessionMemory>[\s\S]*?<\/sessionMemory>/gi, '')
    .replace(/<repoMemory>[\s\S]*?<\/repoMemory>/gi, '')
    .replace(/<attachments>[\s\S]*?<\/attachments>/gi, '')
    .replace(/<context>[\s\S]*?<\/context>/gi, '')
    .replace(/<editorContext>[\s\S]*?<\/editorContext>/gi, '')
    .replace(/<reminderInstructions>[\s\S]*?<\/reminderInstructions>/gi, '')
    .trim()

  const userRequest = stripped.match(/<userRequest>([\s\S]*?)<\/userRequest>/i)
  const bestCandidate = userRequest?.[1]?.trim() || stripped

  return bestCandidate
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function isMeaningfulUserText(text: string): boolean {
  if (!text) return false
  if (/^(powershell|bash|zsh|cmd)$/i.test(text)) return false
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return false
  if (/^[A-Za-z]+\/[A-Za-z_]+$/.test(text)) return false
  return true
}

function readHeader(filePath: string): CodexSessionHeader {
  try {
    const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean)

    let sourceSessionId = path.basename(filePath, '.jsonl')
    let cwd: string | null = null
    let timestamp: string | null = null
    let summary: string | null = null

    if (lines.length > 0) {
      try {
        const first = JSON.parse(lines[0]) as { type?: string; payload?: { id?: string; cwd?: string }; timestamp?: string }
        if (first.type === 'session_meta') {
          if (typeof first.payload?.id === 'string' && first.payload.id.length > 0) sourceSessionId = first.payload.id
          if (typeof first.payload?.cwd === 'string' && first.payload.cwd.length > 0) cwd = first.payload.cwd
          if (typeof first.timestamp === 'string' && first.timestamp.length > 0) timestamp = first.timestamp
        }
      } catch {
        // ignore malformed first line
      }
    }

    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as {
          timestamp?: string
          type?: string
          payload?: {
            type?: string
            role?: string
            content?: unknown
          }
        }

        if (!timestamp && typeof entry.timestamp === 'string' && entry.timestamp.length > 0) timestamp = entry.timestamp

        if (entry.type !== 'response_item' || entry.payload?.type !== 'message' || entry.payload?.role !== 'user') continue

        const prompt = normalizeUserText(parseRoleContent(entry.payload.content))
        if (isMeaningfulUserText(prompt)) {
          summary = prompt.substring(0, 240)
          break
        }
      } catch {
        // ignore malformed lines
      }
    }

    return { sourceSessionId, cwd, timestamp, summary }
  } catch {
    return {
      sourceSessionId: path.basename(filePath, '.jsonl'),
      cwd: null,
      timestamp: null,
      summary: null,
    }
  }
}

function getProjectKey(cwd: string | null, filePath: string): string {
  if (cwd) return `path:${normalizePathForKey(cwd)}`
  return `folder:${normalizePathForKey(path.dirname(filePath))}`
}

function getProjectDisplayName(cwd: string | null, filePath: string): string {
  if (cwd) return path.basename(cwd)
  return path.basename(path.dirname(filePath))
}

function getProjectResolvedPath(cwd: string | null): string | null {
  if (!cwd) return null
  try {
    if (fs.existsSync(cwd) && fs.statSync(cwd).isDirectory()) return cwd
  } catch {
    // ignore inaccessible paths
  }
  return cwd
}

function toAssistantContent(text: string): ContentBlock[] {
  return [{ type: 'text', text }]
}

function toNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function parseCodexTokenUsage(payload: unknown): CodexTokenUsage | null {
  if (!payload || typeof payload !== 'object') return null

  const tokenPayload = payload as {
    info?: {
      last_token_usage?: {
        input_tokens?: unknown
        output_tokens?: unknown
        cached_input_tokens?: unknown
      }
    }
  }

  const usage = tokenPayload.info?.last_token_usage
  if (!usage || typeof usage !== 'object') return null

  const input_tokens = toNumber(usage.input_tokens)
  const output_tokens = toNumber(usage.output_tokens)
  const cache_read_input_tokens = toNumber(usage.cached_input_tokens)

  if (input_tokens === 0 && output_tokens === 0 && cache_read_input_tokens === 0) return null

  return {
    input_tokens,
    output_tokens,
    cache_read_input_tokens,
    cache_creation_input_tokens: 0,
  }
}

export const codexCliAdapter: AgentAdapter = {
  source: 'codex-cli',
  displayName: 'Codex CLI',
  iconSvg: CODEX_ICON_SVG,
  supportsResume: true,

  async listProjects(): Promise<AgentProject[]> {
    const sessionFiles = collectJsonlFiles(CODEX_SESSIONS_DIR)
    const grouped = new Map<string, AgentProject>()

    for (const filePath of sessionFiles) {
      const header = readHeader(filePath)
      const projectId = getProjectKey(header.cwd, filePath)
      const stat = fs.statSync(filePath)

      const existing = grouped.get(projectId)
      if (!existing) {
        grouped.set(projectId, {
          source: 'codex-cli',
          projectId,
          displayName: getProjectDisplayName(header.cwd, filePath),
          resolvedPath: getProjectResolvedPath(header.cwd),
          sessionCount: 1,
          lastModified: stat.mtimeMs,
        })
        continue
      }

      existing.sessionCount += 1
      if (stat.mtimeMs > existing.lastModified) existing.lastModified = stat.mtimeMs
    }

    return Array.from(grouped.values()).sort((a, b) => b.lastModified - a.lastModified)
  },

  async listSessions(projectId: string): Promise<AgentSession[]> {
    const sessionFiles = collectJsonlFiles(CODEX_SESSIONS_DIR)
    const sessions: AgentSession[] = []

    for (const filePath of sessionFiles) {
      const header = readHeader(filePath)
      if (getProjectKey(header.cwd, filePath) !== projectId) continue

      const stat = fs.statSync(filePath)
      const sessionTimestamp = header.timestamp ?? stat.mtime.toISOString()

      sessions.push({
        sourceSessionId: header.sourceSessionId,
        type: 'file',
        sessionKind: 'session',
        filePath,
        timestamp: sessionTimestamp,
        mtimeMs: stat.mtimeMs,
        cwd: header.cwd,
        summary: header.summary,
        subagents: [],
      })
    }

    return sessions.sort((a, b) => b.mtimeMs - a.mtimeMs)
  },

  async getSessionMessages(filePath: string): Promise<Message[]> {
    if (!filePath.endsWith('.jsonl') || !fs.existsSync(filePath)) return []

    const configuredModel = getConfiguredCodexModel()
    const fallbackModel = configuredModel || CODEX_FALLBACK_MODEL

    const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean)
    const messages: Message[] = []
    let lastUserUuid: string | null = null
    let currentTurnId: string | null = null
    let latestAssistantIndexByTurn = new Map<string, number>()
    let modelByTurn = new Map<string, string>()

    for (let i = 0; i < lines.length; i++) {
      try {
        const entry = JSON.parse(lines[i]) as {
          timestamp?: string
          type?: string
          turn_id?: string
          payload?: {
            type?: string
            role?: string
            content?: unknown
            turn_id?: string
            model?: string
          }
        }

        if (entry.type === 'event_msg' && entry.payload?.type === 'task_started' && typeof entry.payload.turn_id === 'string' && entry.payload.turn_id.length > 0) {
          currentTurnId = entry.payload.turn_id
          continue
        }

        if (entry.type === 'turn_context') {
          const payload = entry.payload as { turn_id?: unknown; model?: unknown } | undefined
          const turnId = typeof payload?.turn_id === 'string' && payload.turn_id.length > 0 ? payload.turn_id : null
          if (!turnId) continue

          const model = typeof payload?.model === 'string' && payload.model.length > 0
            ? payload.model
            : fallbackModel
          modelByTurn.set(turnId, model)
          continue
        }

        if (entry.type === 'event_msg' && entry.payload?.type === 'token_count') {
          const usage = parseCodexTokenUsage(entry.payload)
          if (!usage) continue

          const knownTurnIds = Array.from(latestAssistantIndexByTurn.keys())
          const mostRecentTurnId = knownTurnIds.length > 0 ? knownTurnIds[knownTurnIds.length - 1] : null
          const targetTurnId = currentTurnId && latestAssistantIndexByTurn.has(currentTurnId)
            ? currentTurnId
            : mostRecentTurnId
          if (!targetTurnId) continue

          const assistantIndex = latestAssistantIndexByTurn.get(targetTurnId)
          if (assistantIndex === undefined) continue

          const assistant = messages[assistantIndex]
          if (!assistant?.message) continue

          assistant.message.usage = usage
          assistant.message.model = assistant.message.model || modelByTurn.get(targetTurnId) || fallbackModel
          continue
        }

        if (entry.type !== 'response_item') continue
        if (entry.payload?.type !== 'message') continue
        if (entry.payload.role !== 'user' && entry.payload.role !== 'assistant') continue

        const text = parseRoleContent(entry.payload.content)
        if (!text) continue

        const uuid = `codex-${entry.payload.role}-${i}`

        if (entry.payload.role === 'user') {
          const normalized = normalizeUserText(text)
          if (!isMeaningfulUserText(normalized)) continue

          lastUserUuid = uuid
          messages.push({
            type: 'user',
            uuid,
            parentUuid: null,
            timestamp: entry.timestamp,
            message: {
              role: 'user',
              content: normalized,
            },
          })
          continue
        }

        messages.push({
          type: 'assistant',
          uuid,
          parentUuid: lastUserUuid,
          timestamp: entry.timestamp,
          message: {
            id: currentTurnId ? `codex-turn-${currentTurnId}` : `codex-assistant-${i}`,
            role: 'assistant',
            content: toAssistantContent(text),
            model: currentTurnId ? (modelByTurn.get(currentTurnId) || fallbackModel) : fallbackModel,
          },
        })

        if (currentTurnId) latestAssistantIndexByTurn.set(currentTurnId, messages.length - 1)
      } catch {
        // ignore malformed lines
      }
    }

    return messages
  },

  async resumeSession(sourceSessionId: string, cwd: string | null): Promise<void> {
    const dir = cwd && fs.existsSync(cwd) && fs.statSync(cwd).isDirectory() ? cwd : undefined
    launchDetached('codex', ['resume', sourceSessionId], dir)
  },
}
