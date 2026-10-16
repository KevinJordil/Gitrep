import { expect, test, type Locator, type Page } from '@playwright/test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { FAKE_MESSAGE, launchFixture, openRepo, type Fixture } from './fixtures'

test.describe.configure({ mode: 'serial' })

let fx: Fixture
let page: Page
let v: Locator
const row = (subject: string) => v.locator('.graph-rows .row', { has: page.locator('.s', { hasText: new RegExp(`^${subject.replace(/[()"]/g, '\\$&')}$`) }) })
const git = (...args: string[]) => fx.git(fx.alpha, ...args).trim()
const menuOn = async (subject: string) => {
  await row(subject).click({ button: 'right' })
  const menu = page.getByRole('menu', { name: /Actions on commit/ })
  await expect(menu).toBeVisible()
  return menu
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
  // alpha: main = init -> second; feature/y = init -> "feat: y" (adds y.txt).
  git('switch', '-q', '-c', 'feature/y', 'HEAD~1')
  writeFileSync(join(fx.alpha, 'y.txt'), 'y\n')
  git('add', '.')
  git('commit', '-q', '-m', 'feat: y')
  git('switch', '-q', 'main')
  v = await openRepo(page, 'alpha')
  await expect(row('feat: y')).toBeVisible()
})
test.afterAll(async () => {
  await fx?.close()
})

test('the menu opens on right-click with the commit in its title, Escape closes it', async () => {
  const menu = await menuOn('feat: y')
  await expect(menu).toContainText(git('rev-parse', '--short=7', 'feature/y'))
  await expect(menu.getByRole('menuitem', { name: 'Cherry-pick onto main' })).toBeEnabled()
  await page.screenshot({ path: 'e2e-artifacts/commit-menu.png' })
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await expect(v.locator('.commit-panel .cp-subject')).toHaveText('feat: y') // right-click also selects
})

test('create a branch here (invalid name keeps the dialog open)', async () => {
  await (await menuOn('feat: y')).getByRole('menuitem', { name: /Create branch here/ }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Branch name').fill('bad..name')
  await dialog.getByRole('button', { name: 'Create branch' }).click()
  await expect(page.locator('.toast.error')).toContainText('Invalid branch name')
  await dialog.getByLabel('Branch name').fill('from-menu')
  await dialog.getByLabel('Check out the new branch').uncheck()
  await dialog.getByRole('button', { name: 'Create branch' }).click()
  await expect(dialog).toHaveCount(0)
  expect(git('rev-parse', 'from-menu')).toBe(git('rev-parse', 'feature/y'))
  expect(git('branch', '--show-current')).toBe('main')
})

test('create an annotated tag here', async () => {
  await (await menuOn('second alpha')).getByRole('menuitem', { name: /Create tag here/ }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Tag name').fill('v-menu')
  await dialog.getByLabel(/Message/).fill('Menu tag')
  await dialog.getByRole('button', { name: 'Create tag' }).click()
  await expect(row('second alpha').locator('.ref.tag')).toHaveText('v-menu')
  expect(git('cat-file', '-t', 'v-menu')).toBe('tag')
})

test('copy the SHA and explain with Claude', async () => {
  await (await menuOn('feat: y')).getByRole('menuitem', { name: 'Copy SHA' }).click()
  await expect.poll(() => fx.app.evaluate(({ clipboard }) => clipboard.readText())).toBe(git('rev-parse', 'feature/y'))
  await (await menuOn('feat: y')).getByRole('menuitem', { name: 'Explain with Claude' }).click()
  await expect(v.locator('.commit-panel .claude-box')).toContainText(FAKE_MESSAGE)
})

test('check out a commit (detached HEAD), then back to main', async () => {
  await (await menuOn('feat: y')).getByRole('menuitem', { name: 'Check out this commit' }).click()
  await expect(v.locator('.branch-pill')).toContainText('Detached HEAD')
  expect(git('rev-parse', 'HEAD')).toBe(git('rev-parse', 'feature/y'))
  await v.locator('.side-item', { hasText: 'main' }).first().dblclick()
  await expect(v.locator('.branch-pill')).toHaveText('main')
})

test('cherry-pick onto main, then revert it', async () => {
  await (await menuOn('feat: y')).getByRole('menuitem', { name: 'Cherry-pick onto main' }).click()
  await expect.poll(() => git('log', '-1', '--format=%s')).toBe('feat: y')
  expect(existsSync(join(fx.alpha, 'y.txt'))).toBe(true)
  await expect(page.locator('.toast', { hasText: 'Cherry-picked' })).toBeVisible()
  const picked = v.locator('.graph-rows .row').filter({ has: page.locator('.ref.head') })
  await picked.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Revert this commit' }).click()
  await expect.poll(() => git('log', '-1', '--format=%s')).toBe('Revert "feat: y"')
  expect(existsSync(join(fx.alpha, 'y.txt'))).toBe(false)
})

test('reset main soft, then hard after confirmation', async () => {
  const menu = await menuOn('second alpha')
  await menu.getByRole('menuitem', { name: 'Reset main here' }).hover()
  await page.getByRole('menuitem', { name: /^Soft/ }).click()
  await expect.poll(() => git('rev-parse', 'HEAD')).toBe(git('rev-parse', 'v-menu^{commit}'))
  writeFileSync(join(fx.alpha, 'a.txt'), 'local edit\n')
  await expect(v.locator('.row.wip')).toBeVisible()
  const before = git('rev-parse', 'HEAD')
  const hardReset = async () => {
    const again = await menuOn('init alpha')
    await again.getByRole('menuitem', { name: 'Reset main here' }).click()
    await page.getByRole('menuitem', { name: /^Hard/ }).click()
  }
  await page.evaluate(() => ((window as unknown as { __answer: boolean }).__answer = false))
  await hardReset() // declined
  await expect.poll(() => page.evaluate(() => (window as unknown as { __confirms: string[] }).__confirms.length)).toBe(1)
  expect(await page.evaluate(() => (window as unknown as { __confirms: string[] }).__confirms[0])).toMatch(/^Reset main to [0-9a-f]{7} and discard/)
  expect(git('rev-parse', 'HEAD')).toBe(before)
  expect(readFileSync(join(fx.alpha, 'a.txt'), 'utf8')).toBe('local edit\n')
  await page.evaluate(() => ((window as unknown as { __answer: boolean }).__answer = true))
  await hardReset()
  await expect.poll(() => git('rev-parse', 'HEAD')).toBe(git('rev-parse', 'origin/main'))
  expect(readFileSync(join(fx.alpha, 'a.txt'), 'utf8')).toBe('one\n')
  await expect(v.locator('.row.wip')).toHaveCount(0)
})

test('keyboard: Shift+F10 opens the menu, ArrowRight enters the reset submenu, Escape returns focus to the row', async () => {
  const r = row('second alpha')
  await r.focus()
  await page.keyboard.press('Shift+F10')
  const menu = page.getByRole('menu', { name: /Actions on commit/ })
  await expect(menu).toBeVisible()
  await menu.getByRole('menuitem', { name: /^Reset/ }).focus()
  await page.keyboard.press('ArrowRight')
  await expect(page.getByRole('menuitem', { name: /^Soft/ })).toBeFocused()
  await page.keyboard.press('ArrowLeft')
  await expect(menu.getByRole('menuitem', { name: /^Reset/ })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await expect(r).toBeFocused()
})
