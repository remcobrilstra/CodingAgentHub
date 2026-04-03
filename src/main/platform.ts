import os from 'os'
import path from 'path'
import { spawn } from 'child_process'

export type Platform = 'win32' | 'darwin' | 'linux'

export function getPlatform(): Platform {
  return process.platform as Platform
}

export function isWindows(): boolean {
  return process.platform === 'win32'
}

export function isMac(): boolean {
  return process.platform === 'darwin'
}

export function isLinux(): boolean {
  return process.platform === 'linux'
}

export function getConfigDir(): string {
  if (isWindows()) {
    return path.join(os.homedir(), 'AppData', 'Roaming')
  }
  if (isMac()) {
    return path.join(os.homedir(), 'Library', 'Application Support')
  }
  return path.join(os.homedir(), '.config')
}

export function getDataDir(): string {
  return getConfigDir()
}

export interface LaunchResult {
  success: boolean
  error?: string
}

// POSIX shell quoting — safe for paths and args with spaces, quotes, etc.
function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`
}

export function openInCodeEditor(dirPath: string): LaunchResult {
  if (!dirPath) return { success: false, error: 'No directory path provided' }

  try {
    if (isWindows()) {
      spawn('code', [dirPath], {
        detached: true,
        shell: true,
        stdio: 'ignore',
      }).unref()
      return { success: true }
    }

    if (isMac()) {
      spawn('open', ['-a', 'Visual Studio Code', dirPath], {
        detached: true,
        shell: false,
        stdio: 'ignore',
      }).unref()
      return { success: true }
    }

    spawn('code', [dirPath], {
      detached: true,
      shell: false,
      stdio: 'ignore',
    }).unref()
    return { success: true }
  } catch (error) {
    return { success: false, error: String(error) }
  }
}

export function launchDetached(command: string, args: string[], cwd?: string): void {
  const workDir = cwd && cwd.length > 0 ? cwd : os.homedir()

  if (isWindows()) {
    spawn('wt', ['-d', workDir, 'powershell.exe', '-c', `${command} ${args.join(' ')}`], {
      detached: true,
      shell: false,
      stdio: 'ignore',
    }).unref()
    return
  }

  if (isMac()) {
    const shellCmd = `cd ${shellQuote(workDir)} && ${shellQuote(command)} ${args.map(shellQuote).join(' ')}`
    // Escape backslashes and double quotes before embedding in the AppleScript string literal
    const appleScriptCmd = shellCmd.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    const script = `tell application "Terminal"
      activate
      do script "${appleScriptCmd}"
    end tell`
    spawn('osascript', ['-e', script], {
      detached: true,
      stdio: 'ignore',
    }).unref()
    return
  }

  // Linux: try common terminal emulators in order via a bash wrapper
  const shellCmd = `cd ${shellQuote(workDir)} && ${shellQuote(command)} ${args.map(shellQuote).join(' ')}`
  const termScript = [
    `x-terminal-emulator -e bash -c ${shellQuote(shellCmd)}`,
    `gnome-terminal -- bash -c ${shellQuote(shellCmd)}`,
    `xterm -e bash -c ${shellQuote(shellCmd)}`,
  ].join(' || ')
  spawn('bash', ['-c', `(${termScript}) &`], {
    detached: true,
    stdio: 'ignore',
  }).unref()
}
