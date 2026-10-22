import { expect, test, type Locator, type Page } from '@playwright/test'
import { launchFixture, openRepo, type Fixture } from './fixtures'

test.describe.configure({ mode: 'serial' })

let fx: Fixture
let page: Page
let v: Locator
const open = (name: string) => v.locator('.file', { hasText: name }).getByRole('button', { name: new RegExp(name.replace('.', '\\.')) }).first().click()
const fullFile = () => v.getByRole('button', { name: 'Full file', exact: true })
const row = (subject: string) => v.locator('.graph-rows .row', { has: page.locator('.s', { hasText: new RegExp(`^${subject}$`) }) })
const text = (t: string) => v.locator('.line .t', { hasText: new RegExp(`^${t}$`) })

test.beforeAll(async () => {
  fx = await launchFixture()
  page = fx.page
  v = await openRepo(page, 'beta')
})
test.afterAll(async () => {
  await fx?.close()
})

test('Full file shows the unchanged lines between the hunks, and staging still acts on the real hunks', async () => {
  await open('file.txt')
  await expect(v.locator('.hunk-head')).toHaveCount(2)
  await expect(text('line 9')).toBeHidden() // between the two hunks
  await fullFile().click()
  await expect(fullFile()).toHaveAttribute('aria-pressed', 'true')
  await expect(text('line 9')).toBeVisible()
  await expect(text('line 20')).toBeVisible()
  await expect(v.locator('.hunk-head')).toHaveCount(2)
  await expect(v.locator('.line .cb input')).toHaveCount(4) // the 2 deleted and 2 added lines; no checkbox on the context rows
  const nos = await v.locator('.line', { has: page.locator('.t', { hasText: /^line 9$/ }) }).locator('.no').allTextContents()
  expect(nos).toEqual(['9', '9'])
  await v.locator('.hunk').filter({ has: page.locator('.hunk-head') }).nth(1).getByRole('button', { name: 'Stage hunk' }).click()
  await expect.poll(() => fx.git(fx.beta, 'diff', '--cached')).toContain('line 15 CHANGED')
  expect(fx.git(fx.beta, 'diff', '--cached')).not.toContain('line 3 CHANGED')
  expect(fx.git(fx.beta, 'diff', '--cached')).not.toContain('line 9')
  await expect(text('line 9')).toBeVisible() // still the whole file on the unstaged side
})

test('the choice is remembered: it survives opening another file and coming back', async () => {
  await open('notes.txt')
  await open('file.txt')
  await expect(fullFile()).toHaveAttribute('aria-pressed', 'true')
  await expect(text('line 9')).toBeVisible()
})

test('commit details: Full file shows the whole file of that commit', async () => {
  fx.git(fx.beta, 'commit', '-q', '-m', 'stage one hunk')
  await page.evaluate(() => window.dispatchEvent(new Event('focus'))) // the commit was made behind the watcher
  await v.getByRole('button', { name: 'History', exact: true }).click()
  await row('stage one hunk').click()
  await v.locator('.cp-files .file', { hasText: 'file.txt' }).click()
  await expect(fullFile()).toHaveAttribute('aria-pressed', 'true')
  await expect(v.locator('.hunk-head')).toHaveCount(1)
  await expect(text('line 1')).toBeVisible()
  await expect(text('line 20')).toBeVisible()
  await expect(text('line 3')).toBeVisible() // unchanged in this commit
  await fullFile().click()
  await expect(text('line 20')).toBeHidden()
  await fullFile().click()
  await page.mouse.move(1, 1)
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.screenshot({ path: 'e2e-artifacts/full-file.png' })
})
