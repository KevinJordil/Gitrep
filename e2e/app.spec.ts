import { expect, test, type Locator, type Page } from '@playwright/test'
import { FAKE_MESSAGE, launchFixture, type Fixture } from './fixtures'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

test.describe.configure({ mode: 'serial' })

let fx: Fixture
let page: Page
const shot = (name: string) => page.screenshot({ path: `e2e-artifacts/${name}.png` })
const repoView = (): Locator => page.locator('.repo:visible')
const tab = (name: string) => page.locator('.tab-label', { hasText: name })
const row = (name: string) => page.locator('.repo-row').filter({ has: page.getByRole('button', { name, exact: true }) })

test.beforeAll(async () => {
  fx = await launchFixture()
  page = fx.page
  await page.evaluate(() => {
    window.confirm = () => true
  })
})
test.afterAll(async () => {
  await fx?.close()
})

test('1. dashboard shows the repos with their state', async () => {
  await expect(page.locator('.repo-row')).toHaveCount(3)
  await expect(page.locator('.folder')).toHaveCount(1) // grouped by folder
  await expect(row('alpha').locator('.rc-sync')).toContainText('↑1')
  await expect(row('beta')).toContainText('2 modified') // file.txt + notes.txt
  await expect(row('gamma')).toContainText('Detached HEAD')
  await page.getByRole('button', { name: /^Modified/ }).click()
  await expect(page.locator('.repo-row')).toHaveCount(1)
  await expect(page.locator('.repo-row')).toContainText('beta')
  await shot('dashboard')
  await page.getByRole('button', { name: /^All/ }).click()
  await expect(page.locator('.repo-row')).toHaveCount(3)
})

test('2. opening beta shows history and changes', async () => {
  await row('beta').getByRole('button', { name: 'beta', exact: true }).click()
  await expect(tab('beta')).toBeVisible()
  const v = repoView()
  await expect(v.locator('.row .s', { hasText: 'add file' })).toBeVisible()
  await expect(v.locator('.row .s', { hasText: 'add other' })).toBeVisible()
  await expect(v.locator('.file', { hasText: 'file.txt' })).toBeVisible()
  await expect(v.locator('.file', { hasText: 'notes.txt' })).toBeVisible()
  await shot('repo')
})

test('3. staging the first change group from the gutter', async () => {
  const v = repoView()
  await v.locator('.file', { hasText: 'file.txt' }).getByRole('button', { name: /file\.txt/ }).first().click()
  await expect(v.locator('.hunk')).toHaveCount(2)
  await shot('diff')
  await v.locator('.hunk').first().locator('.gbtn').first().click()
  await expect(v.locator('.fgroup', { hasText: 'Staged' }).locator('.file', { hasText: 'file.txt' })).toBeVisible()
  const cached = fx.git(fx.beta, 'diff', '--cached')
  expect(cached).toContain('+line 3 CHANGED')
  expect(cached).not.toContain('line 15')
})

test('4. staging a single added line', async () => {
  const v = repoView()
  await expect(v.locator('.hunk')).toHaveCount(1) // unstaged side now has only the line-15 hunk
  // The file watcher reloads the diff ~300 ms after the previous stage and clears the selection: tick again until the click lands.
  await expect(async () => {
    await v.locator('.hunk .line.add input[type=checkbox]').check({ timeout: 2000 })
    await v.getByRole('button', { name: 'Stage lines' }).click({ timeout: 2000 })
  }).toPass({ timeout: 15_000 })
  await expect.poll(() => fx.git(fx.beta, 'show', ':file.txt')).toContain('line 15 CHANGED')
  const index = fx.git(fx.beta, 'show', ':file.txt').split('\n')
  expect(index).toContain('line 15') // old line kept
  expect(index).toContain('line 3 CHANGED')
})

test('5. unstage all', async () => {
  const v = repoView()
  await v.getByRole('button', { name: 'Unstage all' }).click()
  await expect.poll(() => fx.git(fx.beta, 'diff', '--cached')).toBe('')
})

test('6. discard a hunk', async () => {
  const v = repoView()
  await v.locator('.fgroup', { hasText: 'Unstaged' }).locator('.file', { hasText: 'file.txt' }).getByRole('button', { name: /file\.txt/ }).first().click()
  await expect(v.locator('.hunk')).toHaveCount(2)
  await v.locator('.hunk').nth(1).getByRole('button', { name: 'Discard hunk' }).click()
  await expect(v.locator('.hunk')).toHaveCount(1)
  const wd = fx.git(fx.beta, 'show', 'HEAD:file.txt').split('\n')
  const file = readFileSync(join(fx.beta, 'file.txt'), 'utf8').split('\n')
  expect(file[14]).toBe('line 15')
  expect(file[2]).toBe('line 3 CHANGED')
  expect(wd[14]).toBe('line 15')
})

test('7. commit with a generated message', async () => {
  const v = repoView()
  await v.getByRole('button', { name: 'Stage all' }).click()
  await expect(v.locator('.fgroup', { hasText: 'Staged' }).locator('.file')).toHaveCount(2)
  await v.getByRole('button', { name: 'Generate with Claude' }).click()
  const summary = v.getByPlaceholder('Summary (required)')
  await expect(summary).toHaveValue(FAKE_MESSAGE)
  await v.getByRole('button', { name: /^Commit to/ }).click()
  await expect.poll(() => fx.git(fx.beta, 'log', '-1', '--format=%s').trim()).toBe(FAKE_MESSAGE)
  await expect(v.locator('.right-head')).toContainText('0 files')
  expect(fx.git(fx.beta, 'status', '--porcelain')).toBe('')
  await shot('after-commit')
})

test('8. amend the last commit', async () => {
  const v = repoView()
  const before = fx.git(fx.beta, 'rev-list', '--count', 'HEAD').trim()
  await v.getByLabel('Amend last commit').check()
  const summary = v.getByPlaceholder('Summary (required)')
  await expect(summary).toHaveValue(FAKE_MESSAGE)
  await summary.fill('feat: amended by e2e')
  await v.getByRole('button', { name: /^Commit to/ }).click()
  await expect.poll(() => fx.git(fx.beta, 'log', '-1', '--format=%s').trim()).toBe('feat: amended by e2e')
  expect(fx.git(fx.beta, 'rev-list', '--count', 'HEAD').trim()).toBe(before)
})

test('9. switch branch by double-click', async () => {
  const v = repoView()
  await v.locator('.side-item', { hasText: 'feature/x' }).dblclick()
  await expect.poll(() => fx.git(fx.beta, 'branch', '--show-current').trim()).toBe('feature/x')
  await expect(v.locator('.branch-pill')).toHaveText('feature/x')
})

test('10. push from alpha', async () => {
  await page.getByRole('button', { name: 'Dashboard' }).click()
  await row('alpha').getByRole('button', { name: 'alpha', exact: true }).click()
  const v = repoView()
  await expect(v.getByRole('button', { name: /Push/ })).toContainText('↑1')
  await v.getByRole('button', { name: /Push/ }).click()
  await expect.poll(() => fx.git(fx.remote, 'rev-parse', 'main').trim()).toBe(fx.git(fx.alpha, 'rev-parse', 'HEAD').trim())
  await expect(v.getByRole('button', { name: /Push/ })).not.toContainText('↑')
})

test('11. error toast on a detached HEAD push', async () => {
  await page.getByRole('button', { name: 'Dashboard' }).click()
  await row('gamma').getByRole('button', { name: 'gamma', exact: true }).click()
  const v = repoView()
  await v.getByRole('button', { name: /Push/ }).click()
  await expect(page.locator('.toast.error')).toContainText('Detached HEAD')
})
