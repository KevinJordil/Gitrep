import { _electron, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

export const projectRoot = resolve(__dirname, '..')
export const FAKE_MESSAGE = 'feat: fake message from e2e'

export interface Fixture {
  root: string
  alpha: string
  beta: string
  gamma: string
  remote: string
  app: ElectronApplication
  page: Page
  git: (repo: string, ...args: string[]) => string
  close: () => Promise<void>
}

export function lines(n: number, changed: Record<number, string> = {}): string {
  return Array.from({ length: n }, (_, i) => changed[i + 1] ?? `line ${i + 1}`).join('\n') + '\n'
}

export async function launchFixture(): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), 'gitrep-e2e-'))
  const gitConfig = join(root, 'gitconfig')
  writeFileSync(
    gitConfig,
    '[user]\n\tname = E2E Tester\n\temail = e2e@example.com\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n[pull]\n\trebase = false\n[diff]\n\tmnemonicPrefix = true\n'
  )
  const env = { ...process.env, GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: '1' }
  const git = (repo: string, ...args: string[]) => execFileSync('git', args, { cwd: repo, env, encoding: 'utf8' })

  const work = join(root, 'work')
  mkdirSync(work)
  const [alpha, beta, gamma, remote] = ['alpha', 'beta', 'gamma', 'origin.git'].map((n) => join(work, n))

  // alpha: clean, pushed, plus one local commit (1 to push)
  git(work, 'init', '--bare', remote)
  mkdirSync(alpha)
  git(alpha, 'init')
  writeFileSync(join(alpha, 'a.txt'), 'one\n')
  git(alpha, 'add', '.')
  git(alpha, 'commit', '-m', 'init alpha')
  git(alpha, 'remote', 'add', 'origin', remote)
  git(alpha, 'push', '-u', 'origin', 'main')
  writeFileSync(join(alpha, 'a.txt'), 'one\ntwo\n')
  git(alpha, 'commit', '-am', 'second alpha')

  // beta: two hunks + untracked file + feature/x
  mkdirSync(beta)
  git(beta, 'init')
  writeFileSync(join(beta, 'file.txt'), lines(20))
  git(beta, 'add', '.')
  git(beta, 'commit', '-m', 'add file')
  writeFileSync(join(beta, 'other.txt'), 'x\n')
  git(beta, 'add', '.')
  git(beta, 'commit', '-m', 'add other')
  git(beta, 'branch', 'feature/x')
  writeFileSync(join(beta, 'file.txt'), lines(20, { 3: 'line 3 CHANGED', 15: 'line 15 CHANGED' }))
  writeFileSync(join(beta, 'notes.txt'), 'notes\n')

  // gamma: detached HEAD
  mkdirSync(gamma)
  git(gamma, 'init')
  writeFileSync(join(gamma, 'g.txt'), 'g\n')
  git(gamma, 'add', '.')
  git(gamma, 'commit', '-m', 'init gamma')
  git(gamma, 'checkout', '--detach')

  const fakeClaude = join(root, 'claude')
  writeFileSync(fakeClaude, `#!/bin/sh\necho '${FAKE_MESSAGE}'\n`)
  chmodSync(fakeClaude, 0o755)

  const userData = join(root, 'userData')
  mkdirSync(userData)
  writeFileSync(
    join(userData, 'config.json'),
    JSON.stringify({
      repos: [alpha, beta, gamma].map((path) => ({ path, name: path.split('/').pop() })),
      openTabs: [],
      settings: { claudeModel: 'haiku', claudePath: fakeClaude }
    })
  )

  const app = await _electron.launch({
    args: ['.', '--no-sandbox'],
    cwd: projectRoot,
    env: { ...env, GITREP_USER_DATA: userData, GITREP_HIDDEN: '1' } as Record<string, string>
  })
  const page = await app.firstWindow()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
  await page.waitForLoadState('domcontentloaded')
  return {
    root, alpha, beta, gamma, remote, app, page, git,
    close: async () => {
      await app.close().catch(() => undefined)
      rmSync(root, { recursive: true, force: true })
    }
  }
}

// Opens a repository tab from the dashboard and returns the visible repo view.
export async function openRepo(page: Page, name: string): Promise<Locator> {
  await page.getByRole('button', { name: 'Dashboard' }).click()
  await page.locator('.repo-row').getByRole('button', { name, exact: true }).click()
  return page.locator('.repo:visible')
}
