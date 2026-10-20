import { expect, test, type Locator, type Page } from '@playwright/test'
import { FAKE_MESSAGE, launchFixture, type Fixture } from './fixtures'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  await expect(row('beta')).toContainText('1 modified') // file.txt
  await expect(row('beta')).toContainText('1 untracked') // notes.txt
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
  await expect(v.locator('.hunk').first()).toContainText('line 3 CHANGED')
  await expect(async () => {
    await v.locator('.hunk').first().locator('.gbtn').first().click()
    await expect(v.locator('.fgroup', { hasText: 'Staged' }).locator('.file', { hasText: 'file.txt' })).toBeVisible({ timeout: 2000 })
  }).toPass()
  const cached = fx.git(fx.beta, 'diff', '--cached')
  expect(cached).toContain('+line 3 CHANGED')
  expect(cached).not.toContain('line 15')
})

test('4. staging a single added line', async () => {
  const v = repoView()
  await expect(v.locator('.hunk')).toHaveCount(1) // unstaged side now has only the line-15 hunk
  const box = v.locator('.hunk .line.add input[type=checkbox]')
  await box.check()
  await page.waitForTimeout(1000) // let the watcher-triggered refresh land: the selection must survive it
  await expect(box).toBeChecked()
  await v.getByRole('button', { name: 'Stage lines' }).click()
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
  const summary = v.getByPlaceholder('Summary', { exact: true })
  await expect(summary).toHaveValue(FAKE_MESSAGE)
  await v.getByRole('button', { name: /^Commit to/ }).click()
  await expect.poll(() => fx.git(fx.beta, 'log', '-1', '--format=%s').trim()).toBe(FAKE_MESSAGE)
  await expect(v.locator('.right-head')).toContainText('0 files')
  expect(fx.git(fx.beta, 'status', '--porcelain')).toBe('')
  const toast = await page.locator('.toast').first().boundingBox()
  const btn = await v.getByRole('button', { name: /^Commit to/ }).boundingBox()
  expect(toast && btn).toBeTruthy()
  const code = await v.getByRole('button', { name: /VS Code/ }).boundingBox()
  expect(code).toBeTruthy()
  const t = toast!
  const hits = (b: NonNullable<typeof code>) => t.x < b.x + b.width && b.x < t.x + t.width && t.y < b.y + b.height && b.y < t.y + t.height
  expect(hits(btn!)).toBe(false)
  expect(hits(code!)).toBe(false)
  await shot('after-commit')
})

test('7b. commit message instructions are saved and sent to Claude', async () => {
  const v = repoView()
  writeFileSync(join(fx.beta, 'instr.txt'), 'x\n')
  fx.git(fx.beta, 'add', 'instr.txt')
  const open = () => v.getByRole('button', { name: 'Commit message instructions' }).click()
  const dialog = page.getByRole('dialog', { name: 'Commit message instructions' })
  await expect(v.getByRole('button', { name: 'Commit message instructions' }).locator('.dot')).toHaveCount(0)
  await open()
  await dialog.getByLabel('This repository (beta)').fill('REPO-RULE use French')
  await dialog.getByLabel('All repositories').fill('GLOBAL-RULE no scopes')
  await expect(dialog).toContainText('21 / 4000')
  await expect(dialog).toContainText('Stored in GitRep on this computer, not in the repository.')
  await page.mouse.move(0, 0)
  await dialog.getByLabel('All repositories').blur()
  await shot('commit-instructions')
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(v.getByRole('button', { name: 'Commit message instructions' }).locator('.dot')).toHaveCount(1)
  await open()
  await expect(dialog.getByLabel('This repository (beta)')).toHaveValue('REPO-RULE use French')
  await expect(dialog.getByLabel('All repositories')).toHaveValue('GLOBAL-RULE no scopes')
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await v.getByRole('button', { name: 'Generate with Claude' }).click()
  await expect(v.getByPlaceholder('Summary', { exact: true })).toHaveValue(FAKE_MESSAGE)
  const args = readFileSync(join(fx.root, 'claude-args'), 'utf8')
  const prompt = args.slice(args.indexOf('You write git commit messages.'))
  expect(prompt.indexOf('GLOBAL-RULE no scopes')).toBeGreaterThan(prompt.indexOf('all repositories'))
  expect(prompt.indexOf('REPO-RULE use French')).toBeGreaterThan(prompt.indexOf('GLOBAL-RULE no scopes'))
  expect(prompt).toContain('Keep the output rules above')
  await v.getByPlaceholder('Summary', { exact: true }).fill('')
  fx.git(fx.beta, 'reset', '-q', 'instr.txt')
  rmSync(join(fx.beta, 'instr.txt'))
})

test('8. amend the last commit', async () => {
  const v = repoView()
  const before = fx.git(fx.beta, 'rev-list', '--count', 'HEAD').trim()
  await v.getByLabel('Amend last commit').check()
  const summary = v.getByPlaceholder('Summary', { exact: true })
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

test('12. closing a tab asks first, the close button shows on hover', async () => {
  const close = page.getByRole('button', { name: 'Close gamma' })
  const opacity = () => close.evaluate((el) => getComputedStyle(el).opacity)
  await page.mouse.move(600, 400)
  await expect.poll(opacity).toBe('0')
  await tab('gamma').hover()
  await expect.poll(opacity).toBe('1')
  await close.click()
  const dialog = page.getByRole('dialog', { name: 'Close gamma?' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toBeHidden()
  await expect(tab('gamma')).toBeVisible()
  await tab('gamma').hover()
  await close.click()
  await dialog.getByRole('button', { name: 'Close tab' }).click()
  await expect(tab('gamma')).toHaveCount(0)
  await expect(page.locator('.tab.active')).toContainText('Dashboard')
})
