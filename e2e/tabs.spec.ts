import { expect, test, type Page } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchFixture, type Fixture } from './fixtures'

test.describe.configure({ mode: 'serial' })

let fx: Fixture
let page: Page
const COUNT = 15

test.beforeAll(async () => {
  fx = await launchFixture()
  page = fx.page
  await fx.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 700))
  // Fifteen more repositories, added through a stubbed folder dialog, then all opened as tabs.
  const dirs = Array.from({ length: COUNT }, (_, i) => join(fx.root, 'work', `project-number-${i + 1}`))
  for (const d of dirs) {
    mkdirSync(d)
    fx.git(d, 'init')
    writeFileSync(join(d, 'f.txt'), 'x\n')
    fx.git(d, 'add', '.')
    fx.git(d, 'commit', '-m', 'init')
  }
  await fx.app.evaluate(({ dialog }, filePaths) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths })) as typeof dialog.showOpenDialog
  }, dirs)
  await page.evaluate(async () => {
    const added = await window.api.addRepos()
    await window.api.setOpenTabs(added.map((r) => r.path))
  })
  await page.reload()
  await page.waitForLoadState('domcontentloaded')
})
test.afterAll(async () => {
  await fx?.close()
})

const tabs = () => page.locator('nav.tabs')
const dashboard = () => page.locator('.titlebar > .tab')

test('many tabs: the dashboard stays pinned, the wheel scrolls the tabs, no branch text, the row does not jump', async () => {
  await expect(page.locator('nav.tabs .tab')).toHaveCount(COUNT)
  await expect(page.locator('.tab-branch')).toHaveCount(0)
  const row = async () => (await tabs().boundingBox())!
  const first = page.locator('nav.tabs .tab').first()
  const y0 = (await first.boundingBox())!.y
  const dash0 = (await dashboard().boundingBox())!
  const overflow = await tabs().evaluate((el) => el.scrollWidth > el.clientWidth)
  expect(overflow).toBe(true)
  const h0 = (await row()).height

  const box = await row()
  await page.mouse.move(box.x + box.width / 2, box.y + 12)
  await page.mouse.wheel(0, 400)
  await expect.poll(() => tabs().evaluate((el) => el.scrollLeft)).toBeGreaterThan(100)
  expect((await dashboard().boundingBox())!.x).toBe(dash0.x)
  expect((await first.boundingBox())!.y).toBe(y0)
  expect((await row()).height).toBe(h0)
  await page.mouse.wheel(0, -2000)
  await expect.poll(() => tabs().evaluate((el) => el.scrollLeft)).toBe(0)
  await page.mouse.wheel(300, 0) // a native horizontal wheel works too
  await expect.poll(() => tabs().evaluate((el) => el.scrollLeft)).toBeGreaterThan(100)
})

test('the active tab is scrolled into view; Ctrl+Tab cycles, Ctrl+1 selects the dashboard', async () => {
  await dashboard().click()
  await page.keyboard.press('Control+1')
  await expect(page.locator('.tab.active')).toContainText('Dashboard')
  for (let i = 0; i < COUNT; i++) await page.keyboard.press('Control+Tab')
  const last = page.locator('nav.tabs .tab').last()
  await expect(last).toHaveClass(/active/)
  const inView = async () => {
    const t = (await last.boundingBox())!
    const n = (await tabs().boundingBox())!
    return t.x >= n.x - 1 && t.x + t.width <= n.x + n.width + 1
  }
  await expect.poll(inView).toBe(true)
  await page.keyboard.press('Control+Shift+Tab')
  await expect(page.locator('nav.tabs .tab.active')).toContainText('project-number-14')
  await page.keyboard.press('Control+1')
  await expect(page.locator('.tab.active')).toContainText('Dashboard')
  await page.keyboard.press('Control+Shift+Tab') // wraps to the last tab
  await expect(last).toHaveClass(/active/)
  await expect(page.getByRole('button', { name: 'Add repository' })).toBeVisible()
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.mouse.move(450, 400)
  await page.screenshot({ path: 'e2e-artifacts/tabs-many.png' })
})
