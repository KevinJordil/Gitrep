import { expect, test, type Locator, type Page } from '@playwright/test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { FAKE_TOKEN, startFakeForge, type FakeForge } from './fakeForge'
import { launchFixture, openRepo, type Fixture } from './fixtures'

test.describe.configure({ mode: 'serial' })

let fx: Fixture
let forge: FakeForge
let page: Page
let v: Locator
const git = (...args: string[]) => fx.git(fx.alpha, ...args).trim()
const dialog = () => page.getByRole('dialog', { name: 'Review with Claude' })
const accounts = () => page.getByRole('dialog', { name: 'Accounts' })
const gitlabRow = () => accounts().getByRole('region', { name: 'GitLab 127.0.0.1' })
const userData = (f: string) => readFileSync(join(fx.root, 'userData', f), 'utf8')

test.beforeAll(async () => {
  forge = await startFakeForge()
  fx = await launchFixture()
  page = fx.page
  // alpha: feature/mr has one commit and an open merge request on the fake GitLab at 127.0.0.1.
  git('switch', '-q', '-c', 'feature/mr')
  writeFileSync(join(fx.alpha, 'mr.c'), 'int mr;\n')
  git('add', '.')
  git('commit', '-q', '-m', 'feat: mr')
  git('remote', 'set-url', 'origin', `${forge.url}/team/sub/alpha.git`)
  forge.mrs.push({ project: 'team/sub/alpha', iid: 7, title: 'Add mr.c', source: 'feature/mr', target: 'main', author: 'Kim Dubois', sha: git('rev-parse', 'HEAD'), base: git('rev-parse', 'main') })
  v = await openRepo(page, 'alpha')
})
test.afterAll(async () => {
  await fx?.close()
  await forge?.close()
})

test('an unknown host: the user names its forge once, then adds an account from the review dialog', async () => {
  await v.getByRole('button', { name: 'Review', exact: true }).click()
  await expect(dialog()).toContainText('GitRep does not know which forge 127.0.0.1 is.')
  await dialog().getByRole('button', { name: 'GitLab', exact: true }).click()
  await expect(dialog()).toContainText('No GitLab account for 127.0.0.1: add one to find its merge requests and post comments.')
  expect(JSON.parse(userData('config.json')).settings.forgeHosts).toEqual({ '127.0.0.1': 'gitlab' })
  expect(forge.calls).toEqual([]) // nothing is asked of the forge without an account
  await dialog().getByRole('button', { name: 'Accounts…' }).click()
  await expect(gitlabRow().getByLabel('Instance URL')).toHaveValue(forge.url)
  await expect(gitlabRow()).toContainText('Not configured')
  await gitlabRow().getByLabel('Personal access token').fill('wrong-token')
  await gitlabRow().getByRole('button', { name: 'Test connection' }).click()
  await expect(gitlabRow()).toContainText('GitLab (127.0.0.1) rejected the token (401)')
  await gitlabRow().getByLabel('Personal access token').fill(FAKE_TOKEN)
  await gitlabRow().getByRole('button', { name: 'Test connection' }).click()
  await expect(gitlabRow()).toContainText('Connected as @k.dubois')
  await expect(gitlabRow().getByLabel('Personal access token')).toHaveValue('')
  expect(userData('accounts.json')).not.toContain(FAKE_TOKEN)
  expect(userData('config.json')).not.toContain(FAKE_TOKEN)
  await page.screenshot({ path: 'e2e-artifacts/review-accounts.png' })
  await accounts().getByRole('button', { name: 'Done' }).click()
  await expect(dialog().getByRole('status').filter({ hasText: 'Merge request !7' })).toContainText('Merge request !7 is open for this branch on 127.0.0.1“Add mr.c” · target main · by Kim Dubois')
  await expect(dialog().getByLabel('Compare with')).toHaveValue('origin/main')
  await page.screenshot({ path: 'e2e-artifacts/review-detect.png' })
  await dialog().getByRole('button', { name: 'Cancel' }).click()
})

test('the open merge request shows on the toolbar, the sidebar and the branch menu', async () => {
  await expect(v.getByRole('button', { name: /^Review/ }).locator('.mr')).toHaveText('!7')
  const row = v.locator('.side-item', { has: page.getByRole('button', { name: 'feature/mr', exact: true }) })
  await expect(row.locator('.mrtag')).toHaveText('!7')
  await row.click({ button: 'right' })
  await expect(page.getByRole('menuitem', { name: 'Review MR !7 GitLab' })).toBeVisible()
  await page.getByRole('menuitem', { name: 'Review MR !7 GitLab' }).click()
  await expect(dialog().getByLabel('Branch', { exact: true })).toHaveValue('feature/mr')
  await dialog().getByRole('button', { name: 'Cancel' }).click()
})

test('an unrelated settings save neither clears the badge nor asks the forge again', async () => {
  const before = forge.calls.length
  const handle = v.getByRole('separator', { name: 'Resize the sidebar' })
  const width = () => JSON.parse(userData('config.json')).settings.sidebarWidth
  const w = width()
  await handle.focus()
  await page.keyboard.press('ArrowLeft')
  await expect.poll(width).not.toBe(w)
  await page.waitForTimeout(500) // the saved config is read back: the views have reloaded
  await expect(v.getByRole('button', { name: /^Review/ }).locator('.mr')).toHaveText('!7')
  expect(forge.calls.length).toBe(before)
})

test('the titlebar opens the accounts; removing one forgets the request', async () => {
  await page.getByRole('button', { name: 'Accounts', exact: true }).click()
  await expect(accounts().getByRole('region', { name: 'GitHub github.com' })).toContainText('Not configured')
  await gitlabRow().getByRole('button', { name: 'Remove' }).click()
  await expect(gitlabRow()).toContainText('Remove the token for 127.0.0.1?')
  await gitlabRow().getByRole('button', { name: 'Confirm' }).click()
  await expect(gitlabRow()).toContainText('Not configured')
  await accounts().getByRole('button', { name: 'Done' }).click()
  await expect(v.getByRole('button', { name: /^Review/ }).locator('.mr')).toHaveCount(0)
  expect(JSON.parse(userData('accounts.json'))).toEqual([])
})

test('a repository with no other branch says so instead of measuring forever', async () => {
  const g = await openRepo(page, 'gamma')
  const row = g.locator('.side-item').first()
  await row.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Review with Claude…' }).click()
  await expect(dialog().getByRole('status')).toHaveText('No other branch to compare with.')
  await dialog().getByRole('button', { name: 'Cancel' }).click()
})
