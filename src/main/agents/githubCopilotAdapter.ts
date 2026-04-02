import fs from 'fs'
import os from 'os'
import path from 'path'
import type { AgentAdapter, AgentProject, AgentSession, ContentBlock, Message } from '../../types'

const WORKSPACE_STORAGE_DIR = path.join(os.homedir(), 'AppData', 'Roaming', 'Code', 'User', 'workspaceStorage')
const GITHUB_COPILOT_ICON_SVG = '<svg fill="currentColor" fill-rule="evenodd" height="1em" style="flex:none;line-height:1" viewBox="0 0 24 24" width="1em" xmlns="http://www.w3.org/2000/svg"><title>Github Copilot</title><path d="M19.245 5.364c1.322 1.36 1.877 3.216 2.11 5.817.622 0 1.2.135 1.592.654l.73.964c.21.278.323.61.323.955v2.62c0 .339-.173.669-.453.868C20.239 19.602 16.157 21.5 12 21.5c-4.6 0-9.205-2.583-11.547-4.258-.28-.2-.452-.53-.453-.868v-2.62c0-.345.113-.679.321-.956l.73-.963c.392-.517.974-.654 1.593-.654l.029-.297c.25-2.446.81-4.213 2.082-5.52 2.461-2.54 5.71-2.851 7.146-2.864h.198c1.436.013 4.685.323 7.146 2.864zm-7.244 4.328c-.284 0-.613.016-.962.05-.123.447-.305.85-.57 1.108-1.05 1.023-2.316 1.18-2.994 1.18-.638 0-1.306-.13-1.851-.464-.516.165-1.012.403-1.044.996a65.882 65.882 0 00-.063 2.884l-.002.48c-.002.563-.005 1.126-.013 1.69.002.326.204.63.51.765 2.482 1.102 4.83 1.657 6.99 1.657 2.156 0 4.504-.555 6.985-1.657a.854.854 0 00.51-.766c.03-1.682.006-3.372-.076-5.053-.031-.596-.528-.83-1.046-.996-.546.333-1.212.464-1.85.464-.677 0-1.942-.157-2.993-1.18-.266-.258-.447-.661-.57-1.108-.32-.032-.64-.049-.96-.05zm-2.525 4.013c.539 0 .976.426.976.95v1.753c0 .525-.437.95-.976.95a.964.964 0 01-.976-.95v-1.752c0-.525.437-.951.976-.951zm5 0c.539 0 .976.426.976.95v1.753c0 .525-.437.95-.976.95a.964.964 0 01-.976-.95v-1.752c0-.525.437-.951.976-.951zM7.635 5.087c-1.05.102-1.935.438-2.385.906-.975 1.037-.765 3.668-.21 4.224.405.394 1.17.657 1.995.657h.09c.649-.013 1.785-.176 2.73-1.11.435-.41.705-1.433.675-2.47-.03-.834-.27-1.52-.63-1.813-.39-.336-1.275-.482-2.265-.394zm6.465.394c-.36.292-.6.98-.63 1.813-.03 1.037.24 2.06.675 2.47.968.957 2.136 1.104 2.776 1.11h.044c.825 0 1.59-.263 1.995-.657.555-.556.765-3.187-.21-4.224-.45-.468-1.335-.804-2.385-.906-.99-.088-1.875.058-2.265.394zM12 7.615c-.24 0-.525.015-.84.044.03.16.045.336.06.526l-.001.159a2.94 2.94 0 01-.014.25c.225-.022.425-.027.612-.028h.366c.187 0 .387.006.612.028-.015-.146-.015-.277-.015-.409.015-.19.03-.365.06-.526a9.29 9.29 0 00-.84-.044z"></path></svg>'

function decodeFileUriPath(value: string | undefined): string | null {
  if (!value || !value.startsWith('file://')) return null
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'file:') return null
    let pathname = decodeURIComponent(parsed.pathname)
    if (process.platform === 'win32' && /^\/[a-zA-Z]:/.test(pathname)) pathname = pathname.slice(1)
    return pathname.replace(/\//g, path.sep)
  } catch {
    return null
  }
}

function readWorkspaceFolderPath(workspaceJsonPath: string): string | null {
  try {
    const raw = fs.readFileSync(workspaceJsonPath, 'utf8')
    const obj = JSON.parse(raw) as { folder?: string }
    return decodeFileUriPath(obj.folder)
  } catch {
    return null
  }
}

function getChatSessionsDir(workspaceDir: string): string {
  return path.join(workspaceDir, 'chatSessions')
}

function getChatEditingStatePath(workspaceDir: string, sessionId: string): string {
  return path.join(workspaceDir, 'chatEditingSessions', sessionId, 'state.json')
}

function readJsonl(filePath: string): Array<Record<string, unknown>> {
  try {
    const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean)
    const entries: Array<Record<string, unknown>> = []
    for (const line of lines) {
      try {
        entries.push(JSON.parse(line) as Record<string, unknown>)
      } catch {
        // ignore malformed lines
      }
    }
    return entries
  } catch {
    return []
  }
}

function normalizeUserPrompt(prompt: string): string {
  return prompt
    .replace(/<context>[\s\S]*?<\/context>/g, '')
    .replace(/<editorContext>[\s\S]*?<\/editorContext>/g, '')
    .replace(/<reminderInstructions>[\s\S]*?<\/reminderInstructions>/g, '')
    .replace(/<userRequest>/g, '')
    .replace(/<\/userRequest>/g, '')
    .trim()
}

function extractFirstUserPrompt(entries: Array<Record<string, unknown>>): string | null {
  for (const entry of entries) {
    const k = entry.k
    const v = entry.v
    if (!Array.isArray(k) || k.length < 3 || k[0] !== 'requests' || k[2] !== 'result') continue
    if (!v || typeof v !== 'object') continue

    const result = v as { metadata?: { renderedUserMessage?: Array<{ text?: string }> } }
    const rendered = result.metadata?.renderedUserMessage ?? []
    const textBlock = rendered.find((m) => typeof m?.text === 'string' && m.text.length > 0)
    if (!textBlock?.text) continue

    const normalized = normalizeUserPrompt(textBlock.text)
    if (normalized.length > 0) return normalized.substring(0, 240)
  }
  return null
}

function getSessionSummary(filePath: string, sourceSessionId: string): string {
  const entries = readJsonl(filePath)
  const normalized = extractFirstUserPrompt(entries)
  if (normalized) return normalized
  return `Copilot session ${sourceSessionId.substring(0, 8)}`
}

function stringifyAssistantResponseSegments(value: unknown): string {
  if (!Array.isArray(value)) return ''
  const parts: string[] = []

  for (const segment of value) {
    if (!segment || typeof segment !== 'object') continue
    const seg = segment as { value?: unknown; kind?: unknown }
    if (typeof seg.value === 'string') {
      const trimmed = seg.value.trim()
      if (trimmed.length > 0) parts.push(trimmed)
      continue
    }

    if (seg.kind === 'inlineReference') {
      const inline = segment as { name?: unknown }
      if (typeof inline.name === 'string' && inline.name.trim().length > 0) parts.push(inline.name.trim())
    }
  }

  return parts.join('\n')
}

function convertChatSessionJsonlToMessages(filePath: string): Message[] {
  const entries = readJsonl(filePath)
  const grouped = new Map<number, { user?: string; assistant: string[] }>()

  for (const entry of entries) {
    const k = entry.k
    const v = entry.v
    if (!Array.isArray(k) || k.length < 3 || k[0] !== 'requests') continue

    const requestIndexRaw = Number(k[1])
    if (!Number.isFinite(requestIndexRaw)) continue
    const requestIndex = requestIndexRaw
    const requestSlot = String(k[2])

    if (!grouped.has(requestIndex)) grouped.set(requestIndex, { assistant: [] })
    const bucket = grouped.get(requestIndex)!

    if (requestSlot === 'result' && v && typeof v === 'object') {
      const result = v as { metadata?: { renderedUserMessage?: Array<{ text?: string }> } }
      const userTextRaw = result.metadata?.renderedUserMessage?.find((item) => typeof item?.text === 'string' && item.text.length > 0)?.text
      if (!userTextRaw) continue

      const userText = normalizeUserPrompt(userTextRaw)
      if (!userText) continue
      bucket.user = userText
      continue
    }

    if (requestSlot === 'response') {
      const assistantText = stringifyAssistantResponseSegments(v)
      if (!assistantText) continue
      bucket.assistant.push(assistantText)
    }
  }

  const messages: Message[] = []
  const sortedRequestIndexes = Array.from(grouped.keys()).sort((a, b) => a - b)

  for (const requestIndex of sortedRequestIndexes) {
    const bucket = grouped.get(requestIndex)
    if (!bucket) continue

    const userUuid = `copilot-user-${requestIndex}`
    if (bucket.user) {
      messages.push({
        type: 'user',
        uuid: userUuid,
        parentUuid: null,
        message: {
          role: 'user',
          content: bucket.user,
        },
      })
    }

    if (bucket.assistant.length > 0) {
      const content: ContentBlock[] = [{ type: 'text', text: bucket.assistant.join('\n') }]
      messages.push({
        type: 'assistant',
        uuid: `copilot-assistant-${requestIndex}`,
        parentUuid: bucket.user ? userUuid : null,
        message: {
          role: 'assistant',
          content,
          model: 'github-copilot',
        },
      })
    }
  }

  return messages
}

export const githubCopilotAdapter: AgentAdapter = {
  source: 'github-copilot',
  displayName: 'GitHub Copilot',
  iconSvg: GITHUB_COPILOT_ICON_SVG,
  supportsResume: false,

  async listProjects(): Promise<AgentProject[]> {
    if (!fs.existsSync(WORKSPACE_STORAGE_DIR)) return []

    const entries = fs.readdirSync(WORKSPACE_STORAGE_DIR, { withFileTypes: true })
    const projects: AgentProject[] = []

    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const workspaceDir = path.join(WORKSPACE_STORAGE_DIR, entry.name)
      const workspaceJsonPath = path.join(workspaceDir, 'workspace.json')
      if (!fs.existsSync(workspaceJsonPath)) continue

      const resolvedPath = readWorkspaceFolderPath(workspaceJsonPath)
      const displayName = resolvedPath ? path.basename(resolvedPath) : entry.name
      const chatSessionsDir = getChatSessionsDir(workspaceDir)

      let sessionCount = 0
      let lastModified = fs.statSync(workspaceJsonPath).mtimeMs

      if (fs.existsSync(chatSessionsDir)) {
        const sessionFiles = fs.readdirSync(chatSessionsDir, { withFileTypes: true })
          .filter((file) => file.isFile() && file.name.endsWith('.jsonl'))

        sessionCount = sessionFiles.length

        for (const file of sessionFiles) {
          const stat = fs.statSync(path.join(chatSessionsDir, file.name))
          if (stat.mtimeMs > lastModified) lastModified = stat.mtimeMs
        }
      }

      if (sessionCount <= 0) continue

      projects.push({
        source: 'github-copilot',
        projectId: entry.name,
        displayName,
        resolvedPath,
        sessionCount,
        lastModified,
      })
    }

    return projects.sort((a, b) => b.lastModified - a.lastModified)
  },

  async listSessions(projectId: string): Promise<AgentSession[]> {
    const workspaceDir = path.join(WORKSPACE_STORAGE_DIR, projectId)
    if (!fs.existsSync(workspaceDir)) return []

    const resolvedPath = readWorkspaceFolderPath(path.join(workspaceDir, 'workspace.json'))
    const chatSessionsDir = getChatSessionsDir(workspaceDir)
    if (!fs.existsSync(chatSessionsDir)) return []

    const sessionFiles = fs.readdirSync(chatSessionsDir, { withFileTypes: true })
      .filter((file) => file.isFile() && file.name.endsWith('.jsonl'))

    const sessions: AgentSession[] = []

    for (const file of sessionFiles) {
      const sourceSessionId = file.name.replace(/\.jsonl$/, '')
      const filePath = path.join(chatSessionsDir, file.name)
      const stat = fs.statSync(filePath)
      const editingStatePath = getChatEditingStatePath(workspaceDir, sourceSessionId)
      const hasEditingState = fs.existsSync(editingStatePath)

      sessions.push({
        sourceSessionId,
        type: 'file',
        sessionKind: hasEditingState ? 'agents' : 'session',
        filePath,
        timestamp: stat.mtime.toISOString(),
        mtimeMs: stat.mtimeMs,
        cwd: resolvedPath,
        summary: getSessionSummary(filePath, sourceSessionId),
        subagents: [],
      })
    }

    return sessions.sort((a, b) => b.mtimeMs - a.mtimeMs)
  },

  async getSessionMessages(filePath: string): Promise<Message[]> {
    if (!filePath.endsWith('.jsonl')) return []

    const messages = convertChatSessionJsonlToMessages(filePath)
    if (messages.length > 0) return messages

    return [
      {
        type: 'assistant',
        uuid: `copilot-assistant-empty-${path.basename(filePath)}`,
        parentUuid: null,
        message: {
          role: 'assistant',
          content: [{
            type: 'text',
            text: 'No completed Copilot request/response messages were found in this session. It may contain draft input only.',
          }],
          model: 'github-copilot',
        },
      },
    ]
  },
}
