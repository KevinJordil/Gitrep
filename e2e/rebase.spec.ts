import { expect, test, type Locator, type Page } from '@playwright/test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { FAKE_PLAN, launchFixture, openRepo, type Fixture } from './fixtures'

test.describe.configure({ mode: 'serial' })

let fx: Fixture
let page: Page
let v: Locator
const sha7: Record<string, string> = {}
const git = (...args: string[]) => fx.git(fx.alpha, ...args).trim()
const row = (subject: string) => v.locator('.graph-rows .row', { has: page.locator('.s', { hasText: new RegExp(`^${subject}$`) }) })
const pill = (name: string) => v.locator('.graph-rows .ref', { hasText: new RegExp(`^${name}$`) })
const messages = () => v.locator('.ri-msg .s')
const action = (subject: string) => v.getByLabel(`Action for ${sha7[subject]}`)
const panel = () => v.locator('aside.right')
const confirms = () => page.evaluate(() => (window as unknown as { __confirms: string[] }).__confirms)
const openEditor = async () => {
  await row('second alpha').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Rebase interactively from here…' }).click()
  await expect(v.locator('.ri-head')).toContainText('main onto base-b')
}

// Native drag and drop, driven with one shared DataTransfer.
async function drag(source: Locator, target: Locator) {
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer())
  await source.dispatchEvent('dragstart', { dataTransfer })
  await target.dispatchEvent('dragover', { dataTransfer })
  await target.dispatchEvent('drop', { dataTransfer })
}

test.beforeAll(async () => {
  fx = await launchFixture()
  page = fx.page
  await page.evaluate(() => {
    const w = window as unknown as { __confirms: string[]; __answer: boolean }
    w.__confirms = []
    w.__answer = true
    window.confirm = (m) => (w.__confirms.push(String(m)), w.__answer)
  })
  // alpha: main = init -> second alpha -> feat: one -> fix typo in one -> wip: debug -> feat: two, all pushed.
  // base-b stays at second alpha.
  for (const [file, content, message] of [
    ['one.txt', 'one\n', 'feat: one'],
    ['one.txt', 'one!\n', 'fix typo in one'],
    ['debug.txt', 'debug\n', 'wip: debug'],
    ['two.txt', 'two\n', 'feat: two']
  ]) {
    writeFileSync(join(fx.alpha, file), content)
    git('add', '.')
    git('commit', '-q', '-m', message)
    sha7[message] = git('rev-parse', 'HEAD').slice(0, 7)
  }
  git('push', '-q')
  git('branch', 'base-b', 'HEAD~4')
  v = await openRepo(page, 'alpha')
  await expect(row('feat: two')).toBeVisible()
})
test.afterAll(async () => {
  await fx?.close()
})

test('reorder, fix up, drop and reword from the commit menu', async () => {
  await openEditor()
  await expect(messages()).toHaveText(['feat: two', 'wip: debug', 'fix typo in one', 'feat: one'])
  for (let i = 0; i < 3; i++) await action('feat: two').press('Alt+ArrowDown')
  await expect(messages()).toHaveText(['wip: debug', 'fix typo in one', 'feat: one', 'feat: two'])
  await action('fix typo in one').selectOption('fixup')
  await action('wip: debug').selectOption('drop')
  await action('feat: two').selectOption('reword')
  await v.getByLabel(`New message for ${sha7['feat: two']}`).fill('feat: two, first')
  await expect(v.locator('.ri-row', { hasText: 'fix typo in one' })).toContainText(`melded into ${sha7['feat: one']}`)
  await expect(v.locator('.ri-row', { hasText: 'wip: debug' })).toContainText('will be dropped')
  await expect(panel()).toContainText('4 commits → 2')
  await expect(panel().locator('.rp-chips li')).toHaveText(['1 squashed', '1 dropped', '1 renamed', '1 moved'])
  await expect(panel().locator('.warn-box')).toContainText('4 of these commits are already on a remote')
  await page.screenshot({ path: 'e2e-artifacts/rebase.png' })
  await panel().getByRole('button', { name: 'Start rebase' }).click()
  await expect.poll(() => git('log', '--format=%s')).toBe('feat: one\nfeat: two, first\nsecond alpha\ninit alpha')
  await expect(v.locator('.ri-row')).toHaveCount(0)
  expect(readFileSync(join(fx.alpha, 'one.txt'), 'utf8')).toBe('one!\n')
  expect(existsSync(join(fx.alpha, 'debug.txt'))).toBe(false)
})

test('push the rewritten branch with --force-with-lease after confirmation', async () => {
  await v.locator('.toolbar').getByRole('button', { name: /^Push/ }).click()
  await expect.poll(() => fx.git(fx.remote, 'rev-parse', 'main').trim()).toBe(git('rev-parse', 'main'))
  expect((await confirms()).at(-1)).toMatch(/^main has diverged/)
})

test('a plan proposed by Claude, then back to the original plan and cancel', async () => {
  await openEditor()
  await expect(messages()).toHaveText(['feat: one', 'feat: two, first'])
  await v.getByRole('button', { name: 'Propose with Claude' }).click()
  await expect(v.locator('.ri-plan')).toContainText(FAKE_PLAN)
  await expect(messages()).toHaveText(['feat: two, first', 'feat: one'])
  await expect(panel().locator('.rp-chips li')).toHaveText(['1 moved'])
  await v.getByRole('button', { name: 'Back to the original plan' }).click()
  await expect(v.locator('.ri-plan')).toHaveCount(0)
  await expect(messages()).toHaveText(['feat: one', 'feat: two, first'])
  await panel().getByRole('button', { name: 'Cancel' }).click()
  await expect(v.locator('.ri-row')).toHaveCount(0)
  await expect(row('feat: one')).toBeVisible()
  expect(git('log', '--format=%s')).toBe('feat: one\nfeat: two, first\nsecond alpha\ninit alpha')
})

test('drop a branch on main: interactive rebase onto it', async () => {
  await drag(pill('base-b'), pill('main'))
  await page.getByRole('dialog', { name: /What to do with/ }).getByRole('button', { name: /Interactive rebase onto base-b/ }).click()
  await expect(v.locator('.ri-head')).toContainText('main onto base-b')
  await expect(messages()).toHaveText(['feat: one', 'feat: two, first'])
  await panel().getByRole('button', { name: 'Cancel' }).click()
  await expect(v.locator('.ri-row')).toHaveCount(0)
})

test('undo shortcuts do nothing while the editor is open', async () => {
  const head = git('rev-parse', 'HEAD')
  await openEditor()
  await panel().getByRole('button', { name: 'Cancel' }).focus()
  await page.keyboard.press('Control+z')
  await page.keyboard.press('Control+y')
  await expect(v.locator('.ri-head')).toBeVisible()
  expect(git('rev-parse', 'HEAD')).toBe(head)
  await panel().getByRole('button', { name: 'Cancel' }).click()
})

test('Alt+Down twice moves a row two places; a melded oldest commit is refused', async () => {
  const sha = (subject: string) => git('log', '--format=%h', '--fixed-strings', `--grep=${subject}`, '-1')
  await row('init alpha').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Rebase interactively from here…' }).click()
  await expect(messages()).toHaveText(['feat: one', 'feat: two, first', 'second alpha'])
  await v.getByLabel(`Action for ${sha('feat: one')}`).focus()
  await page.keyboard.press('Alt+ArrowDown')
  await page.keyboard.press('Alt+ArrowDown')
  await expect(messages()).toHaveText(['feat: two, first', 'second alpha', 'feat: one'])
  await v.getByLabel(`Action for ${sha('feat: one')}`).selectOption('squash')
  await expect(panel()).toContainText('has no kept commit below it')
  await expect(panel().getByRole('button', { name: 'Start rebase' })).toBeDisabled()
  await panel().getByRole('button', { name: 'Cancel' }).click()
})

test('declining the force push leaves the remote unchanged', async () => {
  git('commit', '-q', '--amend', '-m', 'feat: one, amended')
  const remote = fx.git(fx.remote, 'rev-parse', 'main').trim()
  await page.evaluate(() => ((window as unknown as { __answer: boolean }).__answer = false))
  await v.locator('.toolbar').getByRole('button', { name: /^Push/ }).click()
  await expect.poll(async () => (await confirms()).at(-1)).toMatch(/has diverged from its remote/)
  expect(fx.git(fx.remote, 'rev-parse', 'main').trim()).toBe(remote)
})
