import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { git } from '../src/main/git'

export function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'gitrep-test-'))
}

export async function makeRepo(): Promise<string> {
  const dir = await tempDir()
  await git(dir, ['init', '-q', '-b', 'main'])
  return dir
}

export async function write(repo: string, path: string, content: string): Promise<void> {
  const full = join(repo, path)
  await mkdir(dirname(full), { recursive: true })
  await writeFile(full, content)
}

export async function commitAll(repo: string, message: string): Promise<void> {
  await git(repo, ['add', '-A'])
  await git(repo, ['commit', '-q', '-m', message])
}

export function lines(n: number, f: (i: number) => string = (i) => `line ${i}`): string {
  return Array.from({ length: n }, (_, i) => f(i + 1)).join('\n') + '\n'
}
