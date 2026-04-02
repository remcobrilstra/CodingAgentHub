export type AgentSource = 'claude' | 'github-copilot' | 'codex-cli'

export interface AdapterInfo {
  source: AgentSource
  displayName: string
}

export type SessionKind = 'session' | 'agents'

export interface ProjectSourceRef {
  source: AgentSource
  projectId: string
}

export interface Project {
  // Stable key for a merged project across multiple agent providers.
  name: string
  displayName: string
  resolvedPath: string | null
  sessionCount: number
  lastModified: number
  sources: AgentSource[]
  sourceRefs: ProjectSourceRef[]
}

export interface Subagent {
  name: string
  filePath: string
}

export interface Session {
  id: string
  type: 'file' | 'folder'
  source: AgentSource
  sourceDisplayName: string
  sourceIconSvg: string
  canResume: boolean
  sourceSessionId: string
  sessionKind: SessionKind
  filePath: string | null
  folderPath?: string
  timestamp: string
  mtimeMs: number
  cwd: string | null
  summary: string | null
  subagents: Subagent[]
}

export interface TextBlock {
  type: 'text'
  text: string
}

export interface ThinkingBlock {
  type: 'thinking'
  thinking: string
  signature?: string
}

export interface ToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}

export interface ToolResultBlock {
  type: 'tool_result'
  tool_use_id: string
  content: string | Array<{ type: string; text?: string }>
  is_error?: boolean
}

export type ContentBlock = TextBlock | ThinkingBlock | ToolUseBlock | ToolResultBlock

export interface MessageUsage {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

export interface MessagePayload {
  id?: string
  role: string
  content: string | ContentBlock[]
  model?: string
  usage?: MessageUsage
}

export interface ModelTokenStats {
  model: string
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
}

export interface Message {
  type: 'user' | 'assistant' | string
  uuid: string
  parentUuid: string | null
  timestamp?: string
  message?: MessagePayload
  cwd?: string
  isSidechain?: boolean
}

export interface SessionFilter {
  kinds?: SessionKind[]
  sources?: AgentSource[]
}

export interface AgentProject {
  source: AgentSource
  projectId: string
  displayName: string
  resolvedPath: string | null
  sessionCount: number
  lastModified: number
}

export interface AgentSession extends Omit<Session, 'id' | 'source' | 'sourceDisplayName' | 'sourceSessionId' | 'sourceIconSvg' | 'canResume'> {
  sourceSessionId: string
}

export interface AgentAdapter {
  source: AgentSource
  displayName: string
  iconSvg: string
  supportsResume: boolean
  listProjects: () => Promise<AgentProject[]>
  listSessions: (projectId: string) => Promise<AgentSession[]>
  getSessionMessages: (filePath: string) => Promise<Message[]>
  resumeSession?: (sourceSessionId: string, cwd: string | null) => Promise<void>
}

export interface ElectronAPI {
  getProjects: () => Promise<Project[]>
  getAdapters: () => Promise<AdapterInfo[]>
  getSessions: (projectName: string, filter?: SessionFilter) => Promise<Session[]>
  getSessionMessages: (filePath: string, source?: AgentSource) => Promise<Message[]>
  openInVscode: (dirPath: string) => Promise<void>
  resumeSession: (source: AgentSource, sourceSessionId: string, cwd: string | null) => Promise<void>
}
