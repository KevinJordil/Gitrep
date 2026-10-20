import { expect, test, type Locator, type Page } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { FAKE_MESSAGE, launchFixture, lines, openRepo, type Fixture } from './fixtures'

test.describe.configure({ mode: 'serial' })

let fx: Fixture
let page: Page
let v: Locator
const git = (...args: string[]) => fx.git(fx.alpha, ...args).trim()
const row = (subject: string) => v.locator('.graph-rows .row', { has: page.locator('.s', { hasText: new RegExp(`^${subject}$`) }) })
const entries = () => v.locator('.fh-item .fh-msg')
const entry = (subject: string) => v.locator('.fh-item', { has: page.locator('.fh-msg', { hasText: new RegExp(`^${subject}$`) }) })
const card = () => v.locator('.fh-card')

test.beforeAll(async () => {
  fx = await launchFixture()
  page = fx.page
  // alpha: guide.txt added, edited (line 2), then moved to docs/guide.md and edited (line 9); then edited again, uncommitted.
  writeFileSync(join(fx.alpha, 'guide.txt'), lines(10))
  git('add', '.')
  git('commit', '-q', '-m', 'docs: add guide')
  writeFileSync(join(fx.alpha, 'guide.txt'), lines(10, { 2: 'two' }))
  git('commit', '-q', '-am', 'docs: edit guide')
  git('rm', '-q', 'guide.txt')
  mkdirSync(join(fx.alpha, 'docs'))
  writeFileSync(join(fx.alpha, 'docs/guide.md'), lines(10, { 2: 'two', 9: 'nine' }))
  git('add', '.')
  git('commit', '-q', '-m', 'docs: move guide')
  writeFileSync(join(fx.alpha, 'docs/guide.md'), lines(10, { 2: 'two', 9: 'nine', 10: 'ten' }))
  v = await openRepo(page, 'alpha')
  await expect(row('docs: move guide')).toBeVisible()
})
test.afterAll(async () => {
  await fx?.close()
})

test('file history from the diff header: renames followed, each commit shows its diff of the file', async () => {
  await v.locator('aside.right .file', { hasText: 'guide.md' }).getByRole('button').first().click()
  await v.getByRole('button', { name: 'File history' }).click()
  await expect(entries()).toHaveText(['docs: move guide', 'docs: edit guide', 'docs: add guide'])
  await expect(v.locator('.fh-head')).toContainText('3 commits')
  await expect(entry('docs: move guide')).toHaveClass(/sel/)
  await expect(entry('docs: move guide')).toContainText('Renamed from guide.txt')
  await expect(v.locator('.center .banner')).toContainText('Renamed from guide.txt')
  await expect(v.locator('.center .line.add .t')).toHaveText(['nine'])
  await entry('docs: edit guide').click()
  await expect(v.locator('.center .line.add .t')).toHaveText(['two'])
  await expect(card()).toContainText('docs: edit guide')
  await expect(v.getByRole('listbox', { name: 'Commits of guide.md' })).toBeVisible()
  await entry('docs: edit guide').focus()
  await page.keyboard.press('ArrowDown')
  await expect(entry('docs: add guide')).toHaveAttribute('aria-selected', 'true')
  await expect(entry('docs: add guide')).toBeFocused()
  await page.keyboard.press('Home')
  await expect(entry('docs: move guide')).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('End')
  await expect(entry('docs: add guide')).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('ArrowUp')
  await expect(entry('docs: edit guide')).toHaveAttribute('aria-selected', 'true')
  await expect(v.locator('.center .line.add .t')).toHaveText(['two'])
  await page.mouse.move(1, 1)
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.screenshot({ path: 'e2e-artifacts/file-history.png' })
  await v.getByLabel('Follow renames').uncheck()
  await expect(entries()).toHaveText(['docs: move guide'])
  await v.getByLabel('Follow renames').check()
  await expect(entries()).toHaveCount(3)
  await v.getByRole('button', { name: 'History', exact: true }).click()
  await expect(row('docs: move guide')).toBeVisible()
})

test('from the file menu of a commit: history up to that commit, explain it, show another one in the graph', async () => {
  await row('docs: edit guide').click()
  await v.locator('.cp-files .file', { hasText: 'guide.txt' }).click({ button: 'right' })
  await page.getByRole('menu', { name: 'Actions on guide.txt' }).getByRole('menuitem', { name: 'File history' }).click()
  await expect(entries()).toHaveText(['docs: edit guide', 'docs: add guide'])
  await card().getByRole('button', { name: 'Explain this commit' }).click()
  await expect(card().locator('.claude-box')).toContainText(FAKE_MESSAGE)
  await entry('docs: add guide').click()
  await card().getByRole('button', { name: 'Show in graph' }).click()
  await expect(row('docs: add guide')).toHaveClass(/sel/)
  await expect(v.locator('.commit-panel .cp-subject')).toHaveText('docs: add guide')
})

test('the file menu of the Changes panel opens with the keyboard too', async () => {
  await v.locator('.row.wip').click()
  await v.locator('aside.right .file', { hasText: 'guide.md' }).getByRole('button').first().press('Shift+F10')
  await page.getByRole('menu', { name: 'Actions on docs/guide.md' }).getByRole('menuitem', { name: 'File history' }).click()
  await expect(entries()).toHaveCount(3)
  await v.getByRole('button', { name: 'History', exact: true }).click()
  await expect(v.locator('.row.wip')).toHaveClass(/sel/)
})
