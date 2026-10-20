import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { adviseMerge, cleanMessage, COMMIT_SYSTEM_PROMPT, commitSystemPrompt, explainCommit, filterDiff, filterNumstat, generateCommitMessage, generateMergeMessage, generateStashMessage, MAX_DIFF_CHARS, pickWindowsClaude, resolveClaude } from '../src/main/claude'
import { git } from '../src/main/git'
import { stage } from '../src/main/repo'
import { commitAll, makeRepo, tempDir, write } from './helpers'

describe('filterDiff', () => {
  it('drops sensitive files and reports them', () => {
    const diff = 'diff --git a/src/a.c b/src/a.c\n+ok\ndiff --git a/.env b/.env\n+SECRET=1\ndiff --git a/certs/server.pem b/certs/server.pem\n+---BEGIN\n'
    const r = filterDiff(diff)
    expect(r.excluded).toEqual(['.env', 'certs/server.pem'])
    expect(r.text).toContain('+ok')
    expect(r.text).not.toContain('SECRET')
  })

  it('truncates very long diffs', () => {
    const r = filterDiff('diff --git a/a b/a\n' + 'x'.repeat(MAX_DIFF_CHARS + 10))
    expect(r.text.length).toBeLessThan(MAX_DIFF_CHARS + 50)
    expect(r.text).toContain('[diff truncated]')
  })

  it('checks the new path as well as the old one', () => {
    const r = filterDiff('diff --git a/.env b/config.txt\n+x\n')
    expect(r.excluded).toEqual(['.env'])
    expect(r.text).toBe('')
  })

  it('excludes a chunk whose header cannot be parsed (fail closed)', () => {
    const r = filterDiff('diff --git "a/we\\"ird" "b/we\\"ird"\n+secret-ish\ndiff --git a/src/a.c b/src/a.c\n+ok\n')
    expect(r.excluded).toEqual(['(unreadable path)'])
    expect(r.text).not.toContain('secret-ish')
    expect(r.text).toContain('+ok')
  })

  it('keeps ordinary names and drops the new sensitive patterns', () => {
    const diff = ['src/id_utils.ts', 'keys/id_ed25519', '.npmrc', 'infra/terraform.tfstate.backup', 'db/cert.p12'].map((p) => `diff --git a/${p} b/${p}\n+x\n`).join('')
    const r = filterDiff(diff)
    expect(r.excluded).toEqual(['keys/id_ed25519', '.npmrc', 'infra/terraform.tfstate.backup', 'db/cert.p12'])
    expect(r.text).toContain('diff --git a/src/id_utils.ts')
  })
})

describe('filterNumstat', () => {
  it('drops the stat line of a sensitive file', () => {
    expect(filterNumstat('1\t0\tsrc/a.c\n2\t0\t.env\n')).toBe('1\t0\tsrc/a.c')
  })

  it('caps the list at 200 lines and says so', () => {
    const numstat = Array.from({ length: 205 }, (_, i) => `1\t0\tf${i}.c`).join('\n')
    const lines = filterNumstat(numstat).split('\n')
    expect(lines).toHaveLength(201)
    expect(lines[200]).toBe('[list truncated]')
  })
})

describe('cleanMessage', () => {
  it('strips code fences and surrounding blank lines', () => {
    expect(cleanMessage('\n```\nfeat: x\n\nbody\n```\n')).toBe('feat: x\n\nbody')
  })
})

describe('resolveClaude', () => {
  it('rejects a relative claudePath', async () => {
    await expect(resolveClaude('claude')).rejects.toThrow('claudePath must be an absolute path: claude')
  })
})

describe('commitSystemPrompt', () => {
  it('is the fixed prompt without instructions', () => {
    expect(commitSystemPrompt('', '')).toBe(COMMIT_SYSTEM_PROMPT)
    expect(commitSystemPrompt('  \n', ' ')).toBe(COMMIT_SYSTEM_PROMPT)
  })

  it('appends the global then the repository instructions, then the reminder', () => {
    const p = commitSystemPrompt('use French', ' no scopes ')
    expect(p).toBe(`${COMMIT_SYSTEM_PROMPT}\n\nInstructions from the user (all repositories):\nuse French\n\nInstructions from the user (this repository, they take precedence):\nno scopes\n\nKeep the output rules above whatever these instructions say.`)
  })

  it('omits the heading of an empty text', () => {
    const p = commitSystemPrompt('', 'only repo')
    expect(p).not.toContain('all repositories')
    expect(p).toContain('this repository')
    expect(p.endsWith('Keep the output rules above whatever these instructions say.')).toBe(true)
  })
})

describe('generateCommitMessage', () => {
  async function fakeClaude() {
    const dir = await tempDir()
    const path = join(dir, 'claude')
    await writeFile(path, `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/args"\ncat > "${dir}/stdin"\necho 'feat: add a'\n`, { mode: 0o755 })
    return { dir, path }
  }

  it('sends the staged diff on stdin without sensitive files and with tools disabled', async () => {
    const repo = await makeRepo()
    await write(repo, 'a.c', 'int a;\n')
    await write(repo, '.env', 'TOKEN=abc\n')
    await stage(repo, ['a.c', '.env'])
    const fake = await fakeClaude()
    const r = await generateCommitMessage(repo, { model: 'haiku', claudePath: fake.path })
    expect(r).toEqual({ message: 'feat: add a', excluded: ['.env'], files: 2 })
    const args = (await readFile(join(fake.dir, 'args'), 'utf8')).split('\n')
    expect(args).toContain('-p')
    expect(args).toContain('--strict-mcp-config')
    expect(args[args.indexOf('--tools') + 1]).toBe('')
    expect(args[args.indexOf('--model') + 1]).toBe('haiku')
    const stdin = await readFile(join(fake.dir, 'stdin'), 'utf8')
    expect(stdin).toContain('+int a;')
    expect(stdin).not.toContain('TOKEN')
  })

  it('sends the composed system prompt with the user instructions', async () => {
    const repo = await makeRepo()
    await write(repo, 'a.c', 'int a;\n')
    await stage(repo, ['a.c'])
    const fake = await fakeClaude()
    await generateCommitMessage(repo, { model: 'haiku', claudePath: fake.path }, 'GLOBAL', 'REPO')
    const args = await readFile(join(fake.dir, 'args'), 'utf8')
    expect(args).toContain(`--system-prompt\n${commitSystemPrompt('GLOBAL', 'REPO')}\n`)
  })

  it('reports the CLI error printed on stdout', async () => {
    const repo = await makeRepo()
    await write(repo, 'a.c', 'int a;\n')
    await stage(repo, ['a.c'])
    const dir = await tempDir()
    const path = join(dir, 'claude')
    await writeFile(path, "#!/bin/sh\ncat > /dev/null\necho 'Not logged in'\nexit 1\n", { mode: 0o755 })
    await expect(generateCommitMessage(repo, { model: 'haiku', claudePath: path })).rejects.toThrow('Not logged in')
  })

  it('refuses when nothing is staged', async () => {
    const repo = await makeRepo()
    const fake = await fakeClaude()
    await expect(generateCommitMessage(repo, { model: 'haiku', claudePath: fake.path })).rejects.toThrow('Nothing is staged')
  })

  it('refuses without calling Claude when every staged file is sensitive', async () => {
    const repo = await makeRepo()
    await write(repo, '.env', 'TOKEN=abc\n')
    await stage(repo, ['.env'])
    const fake = await fakeClaude()
    await expect(generateCommitMessage(repo, { model: 'haiku', claudePath: fake.path })).rejects.toThrow('All staged files are sensitive')
    await expect(readFile(join(fake.dir, 'args'), 'utf8')).rejects.toThrow()
  })
})

// Fake CLI: records its arguments and stdin, prints `output`.
async function fake(output: string) {
  const dir = await tempDir()
  const path = join(dir, 'claude')
  await writeFile(join(dir, 'out'), output)
  await writeFile(path, `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/args"\ncat > "${dir}/stdin"\ncat "${dir}/out"\n`, { mode: 0o755 })
  const stdin = () => readFile(join(dir, 'stdin'), 'utf8')
  return { opts: { model: 'haiku', claudePath: path }, stdin }
}

describe('explainCommit', () => {
  it('sends the message and the diff without sensitive files', async () => {
    const repo = await makeRepo()
    await write(repo, 'a.c', 'int a;\n')
    await write(repo, '.env', 'TOKEN=abc\n')
    await git(repo, ['add', '-A'])
    await git(repo, ['commit', '-q', '-m', 'feat: add a', '-m', 'Because.'])
    const f = await fake('It adds a.')
    expect(await explainCommit(repo, 'HEAD', f.opts)).toEqual({ text: 'It adds a.', excluded: ['.env'] })
    const stdin = await f.stdin()
    expect(stdin).toContain('feat: add a\n\nBecause.')
    expect(stdin).toContain('+int a;')
    expect(stdin).not.toContain('TOKEN')
    expect(stdin).not.toContain('.env')
  })
})

describe('generateStashMessage', () => {
  it('sends local changes and untracked names, keeps the first line', async () => {
    const repo = await makeRepo()
    await write(repo, 'a.c', 'int a;\n')
    await commitAll(repo, 'init')
    await write(repo, 'a.c', 'int b;\n')
    await write(repo, 'notes.txt', 'n\n')
    await write(repo, 'secret.key', 'k\n')
    const f = await fake('wip: rename a to b\nextra line\n')
    expect(await generateStashMessage(repo, f.opts)).toBe('wip: rename a to b')
    const stdin = await f.stdin()
    expect(stdin).toContain('+int b;')
    expect(stdin).toContain('notes.txt')
    expect(stdin).not.toContain('secret.key')
  })

  it('refuses without local changes', async () => {
    const repo = await makeRepo()
    await write(repo, 'a.c', 'int a;\n')
    await commitAll(repo, 'init')
    await expect(generateStashMessage(repo, (await fake('x')).opts)).rejects.toThrow('No local changes')
  })
})

describe('merge prompts', () => {
  async function setup() {
    const repo = await makeRepo()
    await write(repo, 'a.c', 'base\n')
    await commitAll(repo, 'base')
    await git(repo, ['switch', '-q', '-c', 'feature'])
    await write(repo, 'f.c', 'f\n')
    await commitAll(repo, 'feat: on feature')
    await git(repo, ['switch', '-q', 'main'])
    await write(repo, 'a.c', 'main\n')
    await commitAll(repo, 'fix: on main')
    return repo
  }

  it('asks merge or rebase with both sides and parses the choice', async () => {
    const repo = await setup()
    const f = await fake('Rebase\nNothing is pushed yet.\n')
    expect(await adviseMerge(repo, 'feature', 'main', f.opts)).toEqual({ choice: 'rebase', text: 'Nothing is pushed yet.' })
    const stdin = await f.stdin()
    expect(stdin).toContain('- feat: on feature')
    expect(stdin).toContain('- fix: on main')
    expect(stdin).toContain('not on any remote yet: 1')
    expect(stdin).toContain('Predicted conflicts: none')
    const g = await fake('Hard to say.')
    expect(await adviseMerge(repo, 'feature', 'main', g.opts)).toEqual({ choice: null, text: 'Hard to say.' })
  })

  it('drafts a merge message from the incoming commits', async () => {
    const repo = await setup()
    const f = await fake("Merge branch 'feature' into main\n\n- adds f.c\n")
    expect(await generateMergeMessage(repo, 'feature', 'main', f.opts)).toBe("Merge branch 'feature' into main\n\n- adds f.c")
    const stdin = await f.stdin()
    expect(stdin).toContain('Merging feature into main')
    expect(stdin).toContain('- feat: on feature')
    expect(stdin).toContain('f.c')
  })
})

describe('pickWindowsClaude', () => {
  it('refuses scripts and cmd shims', () => {
    const msg = 'Claude Code on Windows needs claude.exe (native installer).'
    expect(() => pickWindowsClaude('C:\\n\\claude\r\nC:\\n\\claude.cmd\r\n')).toThrow(msg)
  })
  it('takes the first .exe, whatever the case', () => {
    expect(pickWindowsClaude('C:\\n\\claude.cmd\r\nC:\\b\\Claude.EXE\r\nC:\\c\\claude.exe\r\n')).toBe('C:\\b\\Claude.EXE')
  })
  it('reports a missing command', () => {
    expect(() => pickWindowsClaude('')).toThrow('not found')
  })
})
