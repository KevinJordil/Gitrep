import { chmod, readFile, writeFile } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { appleScriptString, cmdQuote, codeCommand, handOverCommand, run, shellQuote, terminalCommand, withPath, wtArg } from '../src/main/launch'
import { tempDir } from './helpers'

const HOSTILE = `it's "x" & y | z < > ^ %PATH% $(id) \`id\` ; \\ end`

describe('quoting', () => {
  it('shellQuote survives single quotes', () => {
    expect(shellQuote("a'b")).toBe(`'a'\\''b'`)
  })

  it('appleScriptString escapes backslashes, quotes and line breaks', () => {
    const q = appleScriptString('a"b\\c\nd\re')
    expect(q).toBe('"a\\"b\\\\c\\nd\\re"')
    // Nothing but escaped characters between the quotes: no bare quote, no raw line break.
    expect(q.slice(1, -1).replace(/\\./g, '')).toBe('abcde')
  })

  it('cmdQuote keeps every metacharacter inside quotes and defuses %', () => {
    const q = cmdQuote(HOSTILE)
    // Outside the quoted segments only the ^% separators may appear.
    const outside = q.replace(/"(?:[^"]|"")*"/g, '')
    expect(outside).toMatch(/^(\^%)*$/)
    expect(q).not.toContain('%PATH%')
    // Bare quotes are doubled, so the quote state always comes back.
    expect(q.split('"').length % 2).toBe(1)
  })

  it('cmdQuote drops line breaks and control characters', () => {
    expect(cmdQuote('a\r\nb\x00c&calc')).toBe('"a  b c&calc"')
  })

  it('cmdQuote doubles backslashes before a closing quote', () => {
    expect(cmdQuote('C:\\dir\\')).toBe('"C:\\dir\\\\"')
    expect(cmdQuote('a\\"b')).toBe('"a\\\\""b"')
  })

  it('withPath replaces the PATH key whatever its case', () => {
    expect(withPath({ Path: 'x', A: '1' }, 'd')).toEqual({ Path: `d${delimiter}x`, A: '1' })
    expect(withPath({ A: '1' }, 'd')).toEqual({ A: '1', PATH: `d${delimiter}` })
  })

  it('wtArg escapes the command separator of Windows Terminal', () => {
    expect(wtArg('a;b')).toBe('a\\;b')
  })
})

describe('terminalCommand', () => {
  it('linux: gnome-terminal then x-terminal-emulator', () => {
    expect(terminalCommand('linux', '/r/my repo')).toEqual([
      { cmd: 'gnome-terminal', args: ['--working-directory=/r/my repo'] },
      { cmd: 'x-terminal-emulator', args: [] }
    ])
  })
  it('darwin: open -a Terminal', () => {
    expect(terminalCommand('darwin', '/r/x')).toEqual([{ cmd: 'open', args: ['-a', 'Terminal', '/r/x'] }])
  })
  it('win32: wt.exe then cmd.exe', () => {
    const [wt, cmd] = terminalCommand('win32', 'C:\\My Repo')
    expect(wt).toEqual({ cmd: 'wt.exe', args: ['-d', 'C:\\My Repo'] })
    expect(cmd.cmd).toBe('cmd.exe')
    expect(cmd.verbatim).toBe(true)
    expect(cmd.args).toEqual(['/d', '/v:off', '/s', '/c', '"start "" cmd.exe /k cd /d "C:\\My Repo""'])
  })
})

describe('codeCommand', () => {
  it('runs code directly except on Windows', () => {
    expect(codeCommand('linux', '/r')).toEqual([{ cmd: 'code', args: ['/r'] }])
    expect(codeCommand('darwin', '/r')).toEqual([{ cmd: 'code', args: ['/r'] }])
  })
  it('win32: through cmd.exe with the path quoted', () => {
    expect(codeCommand('win32', 'C:\\a & b')).toEqual([{ cmd: 'cmd.exe', args: ['/d', '/v:off', '/s', '/c', '"code "C:\\a & b""'], verbatim: true }])
  })
})

describe('handOverCommand', () => {
  const ctx = `line one\nline "two" ${HOSTILE}`
  it('linux: separate argv entries, gnome-terminal only', () => {
    expect(handOverCommand('linux', '/r', '/opt/claude', ctx)).toEqual([{ cmd: 'gnome-terminal', args: ['--working-directory=/r', '--', '/opt/claude', ctx] }])
  })
  it('darwin: osascript with a quoted do script', () => {
    const [c] = handOverCommand('darwin', "/r/it's", '/opt/c l/claude', ctx)
    expect(c.cmd).toBe('osascript')
    expect(c.args.filter((a) => a === '-e').length).toBe(c.args.length / 2)
    const script = c.args.filter((a) => a !== '-e').join('\n')
    const line = script.split('\n').find((l) => l.startsWith('do script '))!
    // The AppleScript literal decodes to a shell line whose quoting keeps the context in one word.
    const literal = line.slice('do script '.length)
    expect(literal.startsWith('"') && literal.endsWith('"')).toBe(true)
    expect(literal.slice(1, -1).replace(/\\./g, '')).not.toContain('"')
    expect(literal).not.toMatch(/[\r\n]/)
    const decoded = JSON.parse(literal) as string // AppleScript and JSON agree on these escapes
    expect(decoded).toBe(`cd ${shellQuote("/r/it's")} && ${shellQuote('/opt/c l/claude')} ${shellQuote(ctx)}`)
  })
  it('win32: wt.exe argv, then cmd fallback', () => {
    const [wt, cmd] = handOverCommand('win32', 'C:\\r', 'C:\\c\\claude.exe', 'a;b\nc')
    expect(wt).toEqual({ cmd: 'wt.exe', args: ['-d', 'C:\\r', 'C:\\c\\claude.exe', 'a\\;b\nc'] })
    expect(cmd.cmd).toBe('cmd.exe')
    expect(cmd.verbatim).toBe(true)
    expect(cmd.args.slice(0, 4)).toEqual(['/d', '/v:off', '/s', '/c'])
    expect(cmd.args[4]).toBe('"start "" /d "C:\\r" "C:\\c\\claude.exe" "a;b c""')
  })
  it('win32: every wt.exe argument has its ";" escaped, double quotes become single quotes', () => {
    const [wt, cmd] = handOverCommand('win32', 'C:\\a;b', 'C:\\c;d\\claude.exe', 'x;new-tab cmd /c calc "q"')
    expect(wt.args).toEqual(['-d', 'C:\\a\\;b', 'C:\\c\\;d\\claude.exe', "x\\;new-tab cmd /c calc 'q'"])
    expect(cmd.args[4]).toContain("'q'")
    expect(terminalCommand('win32', 'C:\\a;b')[0].args).toEqual(['-d', 'C:\\a\\;b'])
  })
  it('win32: hostile context stays inside quotes in the cmd fallback', () => {
    const cmd = handOverCommand('win32', 'C:\\r', 'C:\\c\\claude.exe', HOSTILE)[1]
    const line = cmd.args[4].slice(1, -1) // without the /s wrapping quotes
    const outside = line.replace(/"(?:[^"]|"")*"/g, '')
    expect(outside.replace(/\^%/g, '').replace(/\s+/g, ' ')).toBe('start /d ')
    expect(line).not.toContain('%PATH%')
  })
})

describe('run', () => {
  it('tries the commands in order and stops at the first that starts', async () => {
    const dir = await tempDir()
    const out = join(dir, 'out.txt')
    const ok = join(dir, 'ok.sh')
    await writeFile(ok, `#!/bin/sh\nprintf '%s|%s' "$PWD" "$*" > "${out}"\n`)
    await chmod(ok, 0o755)
    await run([{ cmd: join(dir, 'missing'), args: [] }, { cmd: ok, args: ['a', 'b c'] }, { cmd: '/nonexistent/never', args: [] }], dir, process.env)
    for (let i = 0; i < 100; i++) {
      try {
        if ((await readFile(out, 'utf8')).includes('|')) break
      } catch {
        await new Promise((r) => setTimeout(r, 50))
      }
    }
    expect((await readFile(out, 'utf8')).endsWith('|a b c')).toBe(true)
  })
  it('rejects when every command fails', async () => {
    await expect(run([{ cmd: '/nonexistent/a', args: [] }, { cmd: '/nonexistent/b', args: [] }], '/', process.env)).rejects.toThrow()
  })
})
