import { expect, test, type Locator, type Page } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchFixture, openRepo, type Fixture } from './fixtures'

test.describe.configure({ mode: 'serial' })

let fx: Fixture
let page: Page
let v: Locator
const branchRow = (name: string) => v.locator('.sidebar .side-item.br', { has: page.locator('.name', { hasText: new RegExp(`^${name}$`) }) })

test.beforeAll(async () => {
  fx = await launchFixture()
  page = fx.page
  // alpha: main = init -> second; feature/y = init -> "feat: y".
  fx.git(fx.alpha, 'switch', '-q', '-c', 'feature/y', 'HEAD~1')
  writeFileSync(join(fx.alpha, 'y.txt'), 'y\n')
  fx.git(fx.alpha, 'add', '.')
  fx.git(fx.alpha, 'commit', '-q', '-m', 'feat: y')
  fx.git(fx.alpha, 'switch', '-q', 'main')
  v = await openRepo(page, 'alpha')
  await expect(branchRow('feature/y')).toBeVisible()
})
test.afterAll(async () => {
  await fx?.close()
})

test('right-click a sidebar branch: the menu lists its actions, Isolate narrows the graph, Escape returns focus to the row', async () => {
  await branchRow('feature/y').click({ button: 'right' })
  const menu = page.getByRole('menu', { name: 'Actions on branch feature/y' })
  await expect(menu).toBeVisible()
  for (const name of ['Switch to feature/y', 'Merge or rebase feature/y into main…', 'Show only feature/y', 'Hide feature/y', 'Delete feature/y', 'Check out this commit'])
    await expect(menu.getByRole('menuitem', { name })).toBeEnabled()
  await page.screenshot({ path: 'e2e-artifacts/sidebar-branch-menu.png' })
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await expect(branchRow('feature/y').locator('.name')).toBeFocused()

  await branchRow('feature/y').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Show only feature/y' }).click()
  await expect(branchRow('feature/y').getByRole('button', { name: 'Stop isolating feature/y' })).toHaveAttribute('aria-pressed', 'true')
})

test('keyboard: Shift+F10 opens the menu on the focused branch, the current branch cannot be switched to or deleted', async () => {
  await branchRow('main').locator('.name').focus()
  await page.keyboard.press('Shift+F10')
  const menu = page.getByRole('menu', { name: 'Actions on branch main' })
  await expect(menu).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: 'Switch to main' })).toBeDisabled()
  await expect(menu.getByRole('menuitem', { name: 'Delete main' })).toBeDisabled()
  await page.keyboard.press('Escape')
  await expect(branchRow('main').locator('.name')).toBeFocused()
})

test('a short window keeps the whole menu on screen', async () => {
  await fx.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1200, 600))
  await expect.poll(() => page.evaluate(() => window.innerHeight)).toBeLessThan(640)
  await branchRow('main').click({ button: 'right', position: { x: 20, y: 10 } })
  const menu = page.getByRole('menu', { name: 'Actions on branch main' })
  await expect(menu).toBeVisible()
  const last = menu.getByRole('menuitem', { name: 'Explain with Claude' })
  const box = (await last.boundingBox())!
  const height = await page.evaluate(() => window.innerHeight)
  expect(box.y).toBeGreaterThanOrEqual(0)
  expect(box.y + box.height).toBeLessThanOrEqual(height)
  const m = (await menu.boundingBox())!
  expect(m.y).toBeGreaterThanOrEqual(0)
  expect(m.y + m.height).toBeLessThanOrEqual(height)
})
