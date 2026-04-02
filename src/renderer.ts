import type { AdapterInfo, AgentSource, Project, Session, Message, ContentBlock, ToolResultBlock, ElectronAPI, ModelTokenStats, SessionFilter } from './types'

declare const marked: { parse: (text: string) => string; use: (opts: object) => void }

declare global {
  interface Window {
    api: ElectronAPI
    openVscode: () => void
    resumeSession: () => void
  }
}

// ─── Markdown ────────────────────────────────────────────────────────────────

marked.use({ gfm: true, breaks: false })

function renderMarkdown(text: string): string {
  return `<div class="markdown-body">${marked.parse(text)}</div>`
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatTime(iso: string): string {
  const d = new Date(iso)
  const diff = Date.now() - d.getTime()
  const mins = Math.floor(diff / 60000)
  const hours = Math.floor(diff / 3600000)
  const days = Math.floor(diff / 86400000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  if (hours < 24) return `${hours}h ago`
  if (days < 7) return `${days}d ago`
  return d.toLocaleDateString()
}

function formatFullTime(iso: string): string {
  return new Date(iso).toLocaleString()
}

function shortId(id: string): string {
  return id.substring(0, 8)
}

function escapeHtml(str: unknown): string {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function toggleCollapsible(el: Element): void {
  const header = el.querySelector('.thinking-header, .tool-use-header, .tool-result-header')
  const content = el.querySelector('.thinking-content, .tool-use-content, .tool-result-content')
  if (!header || !content) return
  header.addEventListener('click', () => {
    const expanded = header.classList.toggle('expanded')
    content.classList.toggle('visible', expanded)
  })
}

function projectInitial(name: string): string {
  return (name.match(/^([a-zA-Z])/)?.[1] ?? '?').toUpperCase()
}

// ─── Render Functions ─────────────────────────────────────────────────────────

function renderToolResult(block: ToolResultBlock): string {
  let contentStr = ''
  if (typeof block.content === 'string') {
    contentStr = block.content
  } else if (Array.isArray(block.content)) {
    contentStr = block.content.map((c) => (c.type === 'text' ? c.text ?? '' : JSON.stringify(c, null, 2))).join('\n\n')
  } else {
    contentStr = JSON.stringify(block.content, null, 2)
  }
  const isError = block.is_error
  return `
    <div class="content-block tool-result-block">
      <div class="tool-result-header" style="${isError ? 'color:var(--red)' : ''}">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>
        ${isError ? 'Tool Error' : 'Tool Result'}
        <span class="result-id">${escapeHtml(block.tool_use_id ?? '')}</span>
        <svg class="chevron" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>
      </div>
      <div class="tool-result-content">
        <pre class="tool-result-pre">${escapeHtml(contentStr)}</pre>
      </div>
    </div>`
}

function renderContentBlock(block: ContentBlock, toolResultMap: Map<string, ToolResultBlock>): string {
  if (block.type === 'text') {
    return `<div class="content-block text-block">${renderMarkdown(block.text)}</div>`
  }

  if (block.type === 'thinking') {
    return `
      <div class="content-block thinking-block">
        <div class="thinking-header">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 00-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0020 4.77 5.07 5.07 0 0019.91 1S18.73.65 16 2.48a13.38 13.38 0 00-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 005 4.77a5.44 5.44 0 00-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 009 18.13V22"/>
          </svg>
          Thinking
          <svg class="chevron" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>
        </div>
        <div class="thinking-content">${escapeHtml(block.thinking)}</div>
      </div>`
  }

  if (block.type === 'tool_use') {
    const inputStr = JSON.stringify(block.input, null, 2)
    const resultBlock = toolResultMap.get(block.id)
    const resultHtml = resultBlock ? renderToolResult(resultBlock) : ''
    return `
      <div class="content-block tool-use-block">
        <div class="tool-use-header">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z"/>
          </svg>
          <span class="tool-name">${escapeHtml(block.name)}</span>
          <span class="tool-id">${escapeHtml(block.id)}</span>
          <svg class="chevron" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>
        </div>
        <div class="tool-use-content">
          <pre class="tool-input-pre">${escapeHtml(inputStr)}</pre>
        </div>
      </div>
      ${resultHtml}`
  }

  return ''
}

function renderUserMessage(msg: Message): string {
  const content = msg.message?.content
  let html = ''
  if (typeof content === 'string') {
    html = `<div class="content-block text-block">${renderMarkdown(content)}</div>`
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (block.type === 'text') {
        html += `<div class="content-block text-block">${renderMarkdown(block.text)}</div>`
      } else if (block.type === 'tool_result') {
        html += renderToolResult(block)
      } else {
        html += `<div class="content-block text-block">${escapeHtml(JSON.stringify(block))}</div>`
      }
    }
  }
  return html
}

function renderAssistantMessage(msg: Message, toolResultMap: Map<string, ToolResultBlock>): string {
  const content = msg.message?.content
  if (!Array.isArray(content)) return ''
  return content.map((block) => renderContentBlock(block as ContentBlock, toolResultMap)).join('')
}

function renderMessages(messages: Message[], session: Session): void {
  const convBody = document.getElementById('conv-body')!
  convBody.innerHTML = ''

  // Merge streaming assistant messages that share the same message id
  const msgMap = new Map<string, Message>()
  const mergedMessages: Message[] = []

  for (const msg of messages) {
    const key = msg.message?.id ?? msg.uuid
    if (msg.type === 'assistant' && msgMap.has(key)) {
      const existing = msgMap.get(key)!
      const newContent = msg.message?.content
      if (Array.isArray(newContent) && existing.message) {
        if (!Array.isArray(existing.message.content)) existing.message.content = []
        const existingContent = existing.message.content as ContentBlock[]
        for (const block of newContent as ContentBlock[]) {
          const idx = existingContent.findIndex(
            (b) => b.type === block.type && (b.type !== 'tool_use' || (b as {id:string}).id === (block as {id:string}).id)
          )
          if (idx >= 0 && block.type === 'text') {
            ;(existingContent[idx] as { text: string }).text += (block as { text: string }).text ?? ''
          } else if (idx < 0) {
            existingContent.push(block)
          } else {
            Object.assign(existingContent[idx], block)
          }
        }
      }
    } else {
      msgMap.set(key, msg)
      mergedMessages.push(msg)
    }
  }

  // Build tool result map from user messages
  const toolResultMap = new Map<string, ToolResultBlock>()
  for (const msg of mergedMessages) {
    if (msg.type !== 'user') continue
    const content = msg.message?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block.type === 'tool_result' && 'tool_use_id' in block) {
        toolResultMap.set((block as ToolResultBlock).tool_use_id, block as ToolResultBlock)
      }
    }
  }

  for (const msg of mergedMessages) {
    if (msg.type !== 'user' && msg.type !== 'assistant') continue

    // Skip user messages that are only tool results
    if (msg.type === 'user') {
      const content = msg.message?.content
      if (Array.isArray(content) && content.every((b) => b.type === 'tool_result')) continue
    }

    const time = msg.timestamp ? formatFullTime(msg.timestamp) : ''
    const role = msg.type

    const bodyHtml = role === 'user'
      ? renderUserMessage(msg)
      : renderAssistantMessage(msg, toolResultMap)

    if (!bodyHtml.trim()) continue

    const groupEl = document.createElement('div')
    groupEl.className = `msg-group ${role}`
    groupEl.innerHTML = `
      <div class="msg-role-bar">
        ${role === 'user' ? `
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
          User
        ` : `
          ${session.sourceIconSvg}
          ${escapeHtml(session.sourceDisplayName)}
        `}
        <span class="msg-time">${escapeHtml(time)}</span>
      </div>
      <div class="msg-body">${bodyHtml}</div>
    `

    groupEl.querySelectorAll('.thinking-block, .tool-use-block, .tool-result-block').forEach(toggleCollapsible)
    convBody.appendChild(groupEl)
  }

  if (convBody.children.length === 0) {
    convBody.innerHTML = `<div class="empty-state"><p>No displayable messages in this session</p></div>`
  }
}

// ─── State ────────────────────────────────────────────────────────────────────

interface AppState {
  activeProject: string | null
  activeSession: Session | null
  activeResolvedPath: string | null
  activeSessionSourceFilter: 'all' | AgentSource
}

const state: AppState = {
  activeProject: null,
  activeSession: null,
  activeResolvedPath: null,
  activeSessionSourceFilter: 'all',
}

window.openVscode = function (): void {
  if (state.activeResolvedPath) {
    window.api.openInVscode(state.activeResolvedPath)
  }
}

window.resumeSession = function (): void {
  if (state.activeSession && state.activeSession.canResume) {
    window.api.resumeSession(state.activeSession.source, state.activeSession.sourceSessionId, state.activeSession.cwd)
  }
}

// ─── Projects ─────────────────────────────────────────────────────────────────

async function loadProjects(): Promise<void> {
  const projects = await window.api.getProjects()
  const list = document.getElementById('projects-list')!
  const count = document.getElementById('projects-count')!

  count.textContent = String(projects.length)
  list.innerHTML = ''

  for (const p of projects) {
    const el = document.createElement('div')
    el.className = 'project-item'
    el.dataset.name = p.name
    const pathDisplay = p.resolvedPath ?? p.name
    el.innerHTML = `
      <div class="project-item-icon">${projectInitial(p.displayName ?? p.name)}</div>
      <div class="project-item-body">
        <div class="project-item-name" title="${escapeHtml(pathDisplay)}">${escapeHtml(p.displayName ?? p.name)}</div>
        <div class="project-item-path" title="${escapeHtml(pathDisplay)}">${escapeHtml(pathDisplay)}</div>
        <div class="project-item-meta">${p.sessionCount} session${p.sessionCount !== 1 ? 's' : ''}</div>
      </div>
    `
    el.addEventListener('click', () => selectProject(p, el))
    list.appendChild(el)
  }
}

function selectProject(project: Project, el: HTMLElement): void {
  document.querySelectorAll('.project-item.active').forEach((e) => e.classList.remove('active'))
  el.classList.add('active')
  state.activeProject = project.name
  state.activeSession = null
  state.activeResolvedPath = project.resolvedPath ?? null
  document.getElementById('resume-btn')!.classList.add('disabled')

  const pathBar = document.getElementById('path-bar')!
  const pathText = document.getElementById('path-bar-text')!
  const vsBtn = document.getElementById('vscode-btn')!
  pathBar.classList.add('visible')
  if (project.resolvedPath) {
    pathText.textContent = project.resolvedPath
    pathText.classList.remove('unresolved')
    vsBtn.classList.remove('disabled')
  } else {
    pathText.textContent = 'Path could not be resolved'
    pathText.classList.add('unresolved')
    vsBtn.classList.add('disabled')
  }

  loadSessions(project.name)
}

// ─── Sessions ─────────────────────────────────────────────────────────────────

function buildSessionFilter(): SessionFilter | undefined {
  if (state.activeSessionSourceFilter === 'all') return undefined
  return { sources: [state.activeSessionSourceFilter] }
}

function renderSourceFilterOptions(adapters: AdapterInfo[]): void {
  const filter = document.getElementById('session-kind-filter') as HTMLSelectElement
  const currentValue = filter.value

  const options = [
    '<option value="all">All</option>',
    ...adapters.map((adapter) => `<option value="${escapeHtml(adapter.source)}">${escapeHtml(adapter.displayName)}</option>`),
  ]
  filter.innerHTML = options.join('')

  const nextValue = adapters.some((adapter) => adapter.source === currentValue) ? currentValue : 'all'
  filter.value = nextValue
  state.activeSessionSourceFilter = nextValue as 'all' | AgentSource
}

async function loadSourceFilterOptions(): Promise<void> {
  const adapters = await window.api.getAdapters()
  renderSourceFilterOptions(adapters)
}

async function loadSessions(projectName: string): Promise<void> {
  const list = document.getElementById('sessions-list')!
  const count = document.getElementById('sessions-count')!
  list.innerHTML = '<div class="loading"><div class="spinner"></div> Loading…</div>'
  count.textContent = '–'

  const sessions = await window.api.getSessions(projectName, buildSessionFilter())
  count.textContent = String(sessions.length)
  list.innerHTML = ''

  if (sessions.length === 0) {
    document.getElementById('resume-btn')!.classList.add('disabled')
    list.innerHTML = `<div class="empty-state"><p>No sessions found</p></div>`
    return
  }

  for (const s of sessions) {
    const el = document.createElement('div')
    el.className = 'session-item'
    el.dataset.id = s.id

    const subagentChips = s.subagents.length > 0
      ? `<div class="session-subagents">
          ${s.subagents.map((sa) => `
            <span class="subagent-chip" data-filepath="${escapeHtml(sa.filePath)}" data-name="${escapeHtml(sa.name)}">
              ${escapeHtml(sa.name.replace('agent-', ''))}
            </span>`).join('')}
        </div>`
      : ''

    el.innerHTML = `
      <div class="session-item-header">
        <span class="session-badge ${s.type}">${s.sessionKind}</span>
        <span class="session-badge source source-icon" title="${escapeHtml(s.source)}" aria-label="${escapeHtml(s.source)}">
          ${s.sourceIconSvg}
        </span>
        <code style="font-size:10px;color:var(--text-muted)">${shortId(s.id)}</code>
        <span class="session-time">${formatTime(s.timestamp)}</span>
      </div>
      <div class="session-summary${s.summary ? '' : ' no-content'}">${s.summary ? escapeHtml(s.summary) : 'No messages'}</div>
      ${subagentChips}
    `

    el.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.subagent-chip')) return
      selectSession(s, el)
    })

    el.querySelectorAll<HTMLElement>('.subagent-chip').forEach((chip) => {
      chip.addEventListener('click', (e) => {
        e.stopPropagation()
        document.querySelectorAll('.subagent-chip.active').forEach((c) => c.classList.remove('active'))
        chip.classList.add('active')
        selectSession(s, el, chip.dataset.filepath, chip.dataset.name)
      })
    })

    list.appendChild(el)
  }
}

function selectSession(session: Session, el: HTMLElement, subagentPath?: string, subagentName?: string): void {
  document.querySelectorAll('.session-item.active').forEach((e) => e.classList.remove('active'))
  el.classList.add('active')
  state.activeSession = session
  const resumeButton = document.getElementById('resume-btn')!
  if (session.canResume) {
    resumeButton.classList.remove('disabled')
  } else {
    resumeButton.classList.add('disabled')
  }

  const filePath = subagentPath ?? session.filePath
  const label = subagentName ? `Subagent: ${subagentName}` : `Session: ${shortId(session.id)}`

  if (!filePath) {
    document.getElementById('conv-title')!.textContent = label
    document.getElementById('conv-meta')!.textContent = 'No session file found'
    document.getElementById('conv-stats')!.innerHTML = ''
    document.getElementById('conv-body')!.innerHTML = `<div class="empty-state"><p>This session has no main conversation file.</p></div>`
    return
  }

  loadConversation(filePath, label, session)
}

// ─── Token Aggregation ───────────────────────────────────────────────────────

function aggregateTokens(messages: Message[]): ModelTokenStats[] {
  // Each streaming chunk shares the same message.id — keep only the last entry
  // per message.id so we get the final output_tokens count, not intermediate zeros.
  const lastPerMessage = new Map<string, { model: string; usage: NonNullable<NonNullable<Message['message']>['usage']> }>()

  for (const msg of messages) {
    if (msg.type !== 'assistant') continue
    const msgId = msg.message?.id
    const model = msg.message?.model
    const usage = msg.message?.usage
    if (!msgId || !model || !usage) continue
    lastPerMessage.set(msgId, { model, usage })
  }

  const modelMap = new Map<string, ModelTokenStats>()
  for (const { model, usage } of lastPerMessage.values()) {
    if (!modelMap.has(model)) {
      modelMap.set(model, { model, inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 })
    }
    const s = modelMap.get(model)!
    s.inputTokens += usage.input_tokens ?? 0
    s.outputTokens += usage.output_tokens ?? 0
    s.cacheCreationInputTokens += usage.cache_creation_input_tokens ?? 0
    s.cacheReadInputTokens += usage.cache_read_input_tokens ?? 0
  }

  return Array.from(modelMap.values())
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

// ─── Token Modal ──────────────────────────────────────────────────────────────

let currentTokenStats: ModelTokenStats[] = []

function showTokenModal(): void {
  const modal = document.getElementById('token-modal')!
  const body = document.getElementById('token-modal-body')!

  const totalIn = currentTokenStats.reduce((s, m) => s + m.inputTokens + m.cacheReadInputTokens + m.cacheCreationInputTokens, 0)
  const totalOut = currentTokenStats.reduce((s, m) => s + m.outputTokens, 0)

  if (currentTokenStats.length === 0) {
    body.innerHTML = `<p style="color:var(--text-muted);text-align:center;padding:16px">No token usage data in this session</p>`
  } else {
    body.innerHTML = `
      <table class="token-table">
        <thead>
          <tr>
            <th>Model</th>
            <th>Input</th>
            <th>Cache Read</th>
            <th>Cache Write</th>
            <th>Output</th>
          </tr>
        </thead>
        <tbody>
          ${currentTokenStats.map((m) => `
            <tr>
              <td class="model-cell">${escapeHtml(m.model)}</td>
              <td>${fmtTokens(m.inputTokens)}</td>
              <td class="cache">${fmtTokens(m.cacheReadInputTokens)}</td>
              <td class="cache">${fmtTokens(m.cacheCreationInputTokens)}</td>
              <td class="output">${fmtTokens(m.outputTokens)}</td>
            </tr>
          `).join('')}
        </tbody>
        <tfoot>
          <tr>
            <td><strong>Total</strong></td>
            <td colspan="3"><strong>${fmtTokens(totalIn)}</strong> in (incl. cache)</td>
            <td><strong>${fmtTokens(totalOut)}</strong> out</td>
          </tr>
        </tfoot>
      </table>
    `
  }

  modal.classList.add('visible')
}

function hideTokenModal(): void {
  document.getElementById('token-modal')!.classList.remove('visible')
}

// ─── Conversation ─────────────────────────────────────────────────────────────

async function loadConversation(filePath: string, label: string, session: Session): Promise<void> {
  document.getElementById('conv-title')!.textContent = label
  document.getElementById('conv-meta')!.textContent = session.cwd ?? filePath
  document.getElementById('conv-stats')!.innerHTML = ''
  document.getElementById('conv-body')!.innerHTML = '<div class="loading"><div class="spinner"></div> Loading…</div>'

  const messages = await window.api.getSessionMessages(filePath, session.source)

  const userMsgs = messages.filter((m) => m.type === 'user').length
  const assistantMsgs = messages.filter((m) => m.type === 'assistant').length
  const toolCalls = messages.filter(
    (m) => m.type === 'assistant' && Array.isArray(m.message?.content) &&
      (m.message!.content as ContentBlock[]).some((b) => b.type === 'tool_use')
  ).length

  currentTokenStats = aggregateTokens(messages)
  const totalIn = currentTokenStats.reduce((s, m) => s + m.inputTokens, 0)
  const totalOut = currentTokenStats.reduce((s, m) => s + m.outputTokens, 0)
  const tokenHtml = totalIn + totalOut > 0
    ? `<button class="stat-pill token-pill" id="token-btn">${fmtTokens(totalIn)} in / ${fmtTokens(totalOut)} out</button>`
    : ''

  document.getElementById('conv-stats')!.innerHTML = `
    <span class="stat-pill">${userMsgs} user</span>
    <span class="stat-pill">${assistantMsgs} assistant</span>
    ${toolCalls > 0 ? `<span class="stat-pill">${toolCalls} tool calls</span>` : ''}
    ${tokenHtml}
  `

  document.getElementById('token-btn')?.addEventListener('click', showTokenModal)

  renderMessages(messages, session)
}

// ─── Init ─────────────────────────────────────────────────────────────────────

document.getElementById('token-modal')!.addEventListener('click', (e) => {
  if (e.target === e.currentTarget) hideTokenModal()
})
document.getElementById('token-modal-close')!.addEventListener('click', hideTokenModal)
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideTokenModal() })

document.getElementById('session-kind-filter')!.addEventListener('change', (e) => {
  const value = (e.target as HTMLSelectElement).value as 'all' | AgentSource
  state.activeSessionSourceFilter = value
  if (!state.activeProject) return
  loadSessions(state.activeProject)
})

void loadSourceFilterOptions()
  .catch(() => undefined)
  .then(() => loadProjects())
