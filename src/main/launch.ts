import { spawn } from 'node:child_process'
import { delimiter, dirname } from 'node:path'

// Everything that depends on the operating system when opening a terminal, VS Code or Claude Code.
// The builders are pure (argv per platform); `run` is the only place that spawns.

export interface Command {
  cmd: string
  args: string[]
  verbatim?: boolean // Windows: args are already a command line for cmd.exe, Node must not re-quote them
}

const CONTROL = /[\x00-\x1f\x7f]/g

// POSIX shell word: single quotes, a quote inside becomes '\''.
export const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

// AppleScript string literal. Line breaks are written as escapes so the literal stays on one line.
export const appleScriptString = (s: string) =>
  `"${s.replace(/[\\"\n\r\t]/g, (c) => ({ '\\': '\\\\', '"': '\\"', '\n': '\\n', '\r': '\\r', '\t': '\\t' })[c]!).replace(CONTROL, ' ')}"`

// cmd.exe word: double quotes keep & | < > ^ literal, a quote inside is doubled and control characters
// (line breaks end a cmd command) become spaces. %VAR% would still expand inside quotes, so every % leaves
// the quotes and is written ^%: the variable name then contains a quote and stays undefined, and the caret is dropped.
export const cmdQuote = (s: string) =>
  s
    .replace(CONTROL, ' ')
    .split('%')
    // C runtime rule: backslashes before a quote (the inner doubled ones or the closing one) are doubled.
    .map((part) => `"${part.replace(/(\\*)"/g, '$1$1""').replace(/(\\*)$/, '$1$1')}"`)
    .join('^%')

// Windows Terminal reads ";" as the separator of its own commands.
export const wtArg = (s: string) => s.replace(/;/g, '\\;')

// cmd.exe /d /s /c "<line>": /s strips only the outer quotes of the line.
// /v:off: no delayed expansion, whatever the registry says.
const cmdLine = (line: string): Command => ({ cmd: 'cmd.exe', args: ['/d', '/v:off', '/s', '/c', `"${line}"`], verbatim: true })

// env with `dir` first on the PATH, whatever the case of the key (Windows has `Path`).
export function withPath(env: NodeJS.ProcessEnv, dir: string): NodeJS.ProcessEnv {
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
  return { ...env, [key]: `${dir}${delimiter}${env[key] ?? ''}` }
}
export const withClaudeOnPath = (env: NodeJS.ProcessEnv, claudePath: string) => withPath(env, dirname(claudePath))

export function terminalCommand(platform: NodeJS.Platform, dir: string): Command[] {
  if (platform === 'darwin') return [{ cmd: 'open', args: ['-a', 'Terminal', dir] }]
  if (platform === 'win32') return [{ cmd: 'wt.exe', args: ['-d', wtArg(dir)] }, cmdLine(`start "" cmd.exe /k cd /d ${cmdQuote(dir)}`)]
  return [{ cmd: 'gnome-terminal', args: [`--working-directory=${dir}`] }, { cmd: 'x-terminal-emulator', args: [] }]
}

export function codeCommand(platform: NodeJS.Platform, dir: string): Command[] {
  return platform === 'win32' ? [cmdLine(`code ${cmdQuote(dir)}`)] : [{ cmd: 'code', args: [dir] }]
}

// Claude Code started in a terminal at `dir` with `context` as its first message.
export function handOverCommand(platform: NodeJS.Platform, dir: string, claudePath: string, context: string): Command[] {
  if (platform === 'darwin') {
    const shell = `cd ${shellQuote(dir)} && ${shellQuote(claudePath)} ${shellQuote(context)}`
    return [{ cmd: 'osascript', args: ['-e', 'tell application "Terminal"', '-e', `do script ${appleScriptString(shell)}`, '-e', 'activate', '-e', 'end tell'] }]
  }
  if (platform === 'win32') {
    const text = context.replace(/"/g, "'") // a double quote cannot be passed safely through cmd or the C runtime parsing
    return [
      { cmd: 'wt.exe', args: ['-d', wtArg(dir), wtArg(claudePath), wtArg(text)] },
      cmdLine(`start "" /d ${cmdQuote(dir)} ${cmdQuote(claudePath)} ${cmdQuote(text)}`)
    ]
  }
  return [{ cmd: 'gnome-terminal', args: [`--working-directory=${dir}`, '--', claudePath, context] }]
}

function spawnOne({ cmd, args, verbatim }: Command, cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env, detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: verbatim })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

// Starts the first command that can be spawned (the others are fallbacks); rejects with the last error.
export async function run(commands: Command[], cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
  let last: unknown = new Error('No command to run')
  for (const c of commands) {
    try {
      return await spawnOne(c, cwd, env)
    } catch (e) {
      last = e
    }
  }
  throw last
}
