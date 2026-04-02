import { contextBridge, ipcRenderer } from 'electron'
import type { ElectronAPI } from './types'

const api: ElectronAPI = {
  getProjects: () => ipcRenderer.invoke('get-projects'),
  getAdapters: () => ipcRenderer.invoke('get-adapters'),
  getSessions: (projectName, filter) => ipcRenderer.invoke('get-sessions', projectName, filter),
  getSessionMessages: (filePath, source) => ipcRenderer.invoke('get-session-messages', filePath, source),
  openInVscode: (dirPath) => ipcRenderer.invoke('open-in-vscode', dirPath),
  resumeSession: (source, sourceSessionId, cwd) => ipcRenderer.invoke('resume-session', source, sourceSessionId, cwd),
}

contextBridge.exposeInMainWorld('api', api)
