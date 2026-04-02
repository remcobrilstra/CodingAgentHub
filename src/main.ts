import { app, BrowserWindow, ipcMain } from 'electron'
import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'
import type { AdapterInfo, AgentSource, Message, SessionFilter } from './types'
import { claudeAdapter } from './main/agents/claudeAdapter'
import { githubCopilotAdapter } from './main/agents/githubCopilotAdapter'
import { codexCliAdapter } from './main/agents/codexCliAdapter'
import { CatalogService } from './main/services/catalogService'

const adapters = [claudeAdapter, githubCopilotAdapter, codexCliAdapter]
const catalogService = new CatalogService(adapters)

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    title: 'Coding Agent Hub',
    backgroundColor: '#0f1117',
  })
  win.loadFile(path.join(__dirname, '..', 'index.html'))
}

function launchDetached(command: string, args: string[], cwd?: string): void {
  const child = spawn(command, args, {
    cwd,
    detached: true,
    shell: false,
    stdio: 'ignore',
  })
  child.unref()
}

ipcMain.handle('get-projects', async () => catalogService.getProjects())

ipcMain.handle('get-adapters', async (): Promise<AdapterInfo[]> => {
  return adapters
    .map((adapter) => ({
      source: adapter.source,
      displayName: adapter.displayName,
    }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName))
})

ipcMain.handle('get-sessions', async (_event, projectName: string, filter?: SessionFilter) => {
  return catalogService.getSessions(projectName, filter)
})

ipcMain.handle('get-session-messages', async (_event, filePath: string, source?: AgentSource): Promise<Message[]> => {
  if (source) {
    const adapter = adapters.find((candidate) => candidate.source === source)
    if (adapter) return adapter.getSessionMessages(filePath)
  }

  for (const adapter of adapters) {
    const messages = await adapter.getSessionMessages(filePath)
    if (messages.length > 0) return messages
  }
  return []
})

ipcMain.handle('open-in-vscode', async (_event, dirPath: string): Promise<void> => {
  if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) return
  launchDetached('code', [dirPath])
})

ipcMain.handle('resume-session', async (_event, source: AgentSource, sourceSessionId: string, cwd: string | null): Promise<void> => {
  const adapter = adapters.find((candidate) => candidate.source === source)
  if (!adapter?.supportsResume || !adapter.resumeSession) return
  await adapter.resumeSession(sourceSessionId, cwd)
})

app.whenReady().then(createWindow)
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
