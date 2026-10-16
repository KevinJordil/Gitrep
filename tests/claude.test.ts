import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { cleanMessage, filterDiff, filterNumstat, generateCommitMessage, MAX_DIFF_CHARS, resolveClaude } from '../src/main/claude'
import { stage } from '../src/main/repo'
import { makeRepo, tempDir, write } from './helpers'

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
