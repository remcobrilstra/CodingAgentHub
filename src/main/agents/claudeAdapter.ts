import fs from 'fs'
import os from 'os'
import path from 'path'
import type { AgentAdapter, AgentProject, AgentSession, Message, Subagent } from '../../types'
import { launchDetached } from '../platform'

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects')
const CLAUDE_ICON_SVG = '<svg class="agent-source-icon" width="12" height="12" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z"/></svg>'

function isSessionDir(name: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(name)
}

function backtrackPath(currentPath: string, tokens: string[], index: number): string | null {
  if (index >= tokens.length) return currentPath
  let segment = ''
  for (let i = index; i < tokens.length; i++) {
    segment += (segment ? '-' : '') + tokens[i]
    const candidate = path.join(currentPath, segment)
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      const result = backtrackPath(candidate, tokens, i + 1)
      if (result !== null) return result
    }
  }
  return null
}

function decodeProjectPath(folderName: string): string | null {
  const match = folderName.match(/^([a-zA-Z])--(.+)$/)
  if (!match) return null
  const drive = match[1].toUpperCase() + '\\'
  const tokens = match[2].split('-').filter(Boolean)
  return backtrackPath(drive, tokens, 0)
}

function getCwd(lines: string[]): string | null {
  for (const line of lines) {
    try {
      const obj = JSON.parse(line) as { cwd?: string }
      if (obj.cwd) return obj.cwd
    } catch {
      // ignore invalid json lines
    }
  }
  return null
}

function getCwdFromProjectDir(projectPath: string): string | null {
  try {
    const items = fs.readdirSync(projectPath)
    for (const item of items) {
      if (!item.endsWith('.jsonl')) continue
      const content = fs.readFileSync(path.join(projectPath, item), 'utf8')
      for (const line of content.split('\n')) {
        if (!line.trim()) continue
        try {
          const obj = JSON.parse(line) as { cwd?: string }
          if (obj.cwd) return obj.cwd
        } catch {
          // ignore invalid json lines
        }
      }
    }
  } catch {
    // ignore inaccessible project folders
  }
  return null
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

function getFirstUserMessage(lines: string[]): string | null {
  for (const line of lines) {
    try {
      const obj = JSON.parse(line) as Message
      if (obj.type !== 'user' || !obj.message?.content) continue
      const content = obj.message.content
      if (typeof content === 'string') {
        const normalized = normalizeUserText(content)
        if (normalized) return normalized.substring(0, 120)
        continue
      }
      if (Array.isArray(content)) {
        const textBlock = content.find((c) => c.type === 'text')
        if (textBlock?.type === 'text') {
          const normalized = normalizeUserText(textBlock.text)
          if (normalized) return normalized.substring(0, 120)
        }
      }
    } catch {
      // ignore invalid json lines
    }
  }
  return null
}

function parseSessionSummary(filePath: string): { cwd: string | null; summary: string | null } {
  try {
    const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean)
    return { cwd: getCwd(lines), summary: getFirstUserMessage(lines) }
  } catch {
    return { cwd: null, summary: null }
  }
}

export const claudeAdapter: AgentAdapter = {
  source: 'claude',
  displayName: 'Claude',
  iconSvg: CLAUDE_ICON_SVG,
  supportsResume: true,

  async listProjects(): Promise<AgentProject[]> {
    if (!fs.existsSync(PROJECTS_DIR)) return []

    const entries = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
    const projects: AgentProject[] = []

    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const projectPath = path.join(PROJECTS_DIR, entry.name)
      const items = fs.readdirSync(projectPath, { withFileTypes: true })

      let sessionCount = 0
      let lastModified = 0

      for (const item of items) {
        if (item.name === 'memory') continue
        if (item.isFile() && item.name.endsWith('.jsonl')) {
          sessionCount++
          const stat = fs.statSync(path.join(projectPath, item.name))
          if (stat.mtimeMs > lastModified) lastModified = stat.mtimeMs
        } else if (item.isDirectory() && isSessionDir(item.name)) {
          sessionCount++
          const stat = fs.statSync(path.join(projectPath, item.name))
          if (stat.mtimeMs > lastModified) lastModified = stat.mtimeMs
        }
      }

      const resolvedPath = getCwdFromProjectDir(projectPath) || decodeProjectPath(entry.name)
      const displayName = resolvedPath
        ? path.basename(resolvedPath)
        : entry.name.replace(/^[a-zA-Z]--/, '').split('-').pop() ?? entry.name

      if (sessionCount <= 0) continue

      projects.push({
        source: 'claude',
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
    const projectPath = path.join(PROJECTS_DIR, projectId)
    if (!fs.existsSync(projectPath)) return []

    const items = fs.readdirSync(projectPath, { withFileTypes: true })
    const sessions: AgentSession[] = []

    for (const item of items) {
      if (item.name === 'memory') continue

      if (item.isFile() && item.name.endsWith('.jsonl')) {
        const sourceSessionId = item.name.replace('.jsonl', '')
        const filePath = path.join(projectPath, item.name)
        const stat = fs.statSync(filePath)
        const { cwd, summary } = parseSessionSummary(filePath)

        sessions.push({
          sourceSessionId,
          type: 'file',
          sessionKind: 'session',
          filePath,
          timestamp: stat.mtime.toISOString(),
          mtimeMs: stat.mtimeMs,
          cwd,
          summary,
          subagents: [],
        })
        continue
      }

      if (!item.isDirectory() || !isSessionDir(item.name)) continue

      const folderPath = path.join(projectPath, item.name)
      const stat = fs.statSync(folderPath)
      const subagentsPath = path.join(folderPath, 'subagents')
      let subagents: Subagent[] = []

      if (fs.existsSync(subagentsPath)) {
        subagents = fs.readdirSync(subagentsPath)
          .filter((f) => f.endsWith('.jsonl'))
          .map((f) => ({ name: f.replace('.jsonl', ''), filePath: path.join(subagentsPath, f) }))
      }

      const mainFile = path.join(folderPath, `${item.name}.jsonl`)
      let filePath: string | null = null
      let cwd: string | null = null
      let summary: string | null = null

      if (fs.existsSync(mainFile)) {
        filePath = mainFile
        const parsed = parseSessionSummary(mainFile)
        cwd = parsed.cwd
        summary = parsed.summary
      } else if (subagents.length > 0) {
        const parsed = parseSessionSummary(subagents[0].filePath)
        cwd = parsed.cwd
        summary = parsed.summary
      }

      sessions.push({
        sourceSessionId: item.name,
        type: 'folder',
        sessionKind: 'agents',
        filePath,
        folderPath,
        timestamp: stat.mtime.toISOString(),
        mtimeMs: stat.mtimeMs,
        cwd,
        summary,
        subagents,
      })
    }

    return sessions.sort((a, b) => b.mtimeMs - a.mtimeMs)
  },

  async getSessionMessages(filePath: string): Promise<Message[]> {
    const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean)
    const messages: Message[] = []
    for (const line of lines) {
      try {
        const obj = JSON.parse(line) as Message
        if (obj.type === 'file-history-snapshot' || obj.type === 'queue-operation') continue
        messages.push(obj)
      } catch {
        // ignore invalid json lines
      }
    }
    return messages
  },

  async resumeSession(sourceSessionId: string, cwd: string | null): Promise<void> {
    const dir = cwd && fs.existsSync(cwd) && fs.statSync(cwd).isDirectory() ? cwd : undefined
    launchDetached('claude', ['--resume', sourceSessionId], dir)
  },
}
