import { expect, test, type Locator, type Page } from '@playwright/test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchFixture, openRepo, type Fixture } from './fixtures'

test.describe.configure({ mode: 'serial' })

let fx: Fixture
let page: Page
let v: Locator
const saved = () => JSON.parse(readFileSync(join(fx.root, 'userData', 'config.json'), 'utf8')).settings
const widthOf = async (l: Locator) => Math.round((await l.boundingBox())!.width)

test.beforeAll(async () => {
  fx = await launchFixture()
  page = fx.page
  v = await openRepo(page, 'beta')
})
test.afterAll(async () => {
  await fx?.close()
})

// A screenshot with no focus ring and no hover.
async function shot(name: string) {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.mouse.move(600, 10)
  await page.screenshot({ path: `e2e-artifacts/${name}.png` })
}

// Drags the handle sideways by dx with the mouse.
async function drag(handle: Locator, dx: number) {
  const box = (await handle.boundingBox())!
  const x = box.x + box.width / 2
  const y = box.y + 200
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + dx, y, { steps: 5 })
  await page.mouse.up()
}

test('the sidebar resizes with the mouse and the keyboard, double-click resets it; the width is saved', async () => {
  const sidebar = v.locator('.sidebar')
  const handle = v.getByRole('separator', { name: 'Resize the sidebar' })
  await expect(handle).toHaveAttribute('aria-orientation', 'vertical')
  expect(await widthOf(sidebar)).toBe(232)
  await drag(handle, 60)
  await expect.poll(() => widthOf(sidebar)).toBe(292)
  await expect.poll(() => saved().sidebarWidth).toBe(292)
  await expect(handle).toHaveAttribute('aria-valuenow', '292') // the saved width is back from the config
  await handle.focus()
  await page.keyboard.press('ArrowLeft')
  await expect.poll(() => widthOf(sidebar)).toBe(276)
  await expect(handle).toHaveAttribute('aria-valuenow', '276')
  await drag(handle, -500) // stops at the minimum
  await expect.poll(() => widthOf(sidebar)).toBe(160)
  await handle.dblclick()
  await expect.poll(() => widthOf(sidebar)).toBe(232)
  await expect.poll(() => saved().sidebarWidth).toBe(232)
})

test('the right panel resizes from its left edge', async () => {
  const right = v.locator('aside.right')
  const handle = v.getByRole('separator', { name: 'Resize the right panel' })
  expect(await widthOf(right)).toBe(360)
  await drag(handle, -100)
  await expect.poll(() => widthOf(right)).toBe(460)
  await expect.poll(() => saved().rightWidth).toBe(460)
  await shot('resized-panes')
})

test('the history columns resize from the header, header and rows stay aligned; double-click resets', async () => {
  await v.getByRole('separator', { name: 'Resize the right panel' }).dblclick() // a wide center pane shows the Author column
  await expect.poll(() => widthOf(v.locator('aside.right'))).toBe(360)
  const headCell = v.locator('.cols .c-author')
  const rowCell = v.locator('.graph-rows .row:not(.wip) .c-author').first()
  const handle = v.getByRole('separator', { name: 'Resize the Author column' })
  await expect(handle).toHaveAttribute('aria-valuenow', '150')
  expect(await widthOf(headCell)).toBe(150)
  const box = (await handle.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 - 60, box.y + box.height / 2, { steps: 5 })
  await page.mouse.up()
  await expect.poll(() => widthOf(headCell)).toBe(210)
  expect(await widthOf(rowCell)).toBe(210)
  await expect.poll(() => saved().graphColumns).toEqual({ author: 210, date: 110, sha: 70 })
  await expect(handle).toHaveAttribute('aria-valuenow', '210')
  await shot('resized-columns')
  await handle.focus()
  await page.keyboard.press('ArrowRight')
  await expect.poll(() => widthOf(rowCell)).toBe(202)
  await expect.poll(() => saved().graphColumns.author).toBe(202)
  await handle.dblclick()
  await expect.poll(() => widthOf(headCell)).toBe(150)
  expect(await widthOf(rowCell)).toBe(150)
  await expect.poll(() => saved().graphColumns).toEqual({ author: 150, date: 110, sha: 70 })
})

test('wide saved widths are clamped to a small window; the saved values are kept', async () => {
  await page.evaluate(() => (window as any).api.updateSettings({ sidebarWidth: 480, rightWidth: 720 }))
  await expect.poll(() => saved().rightWidth).toBe(720)
  await fx.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 700))
  const center = v.locator('section.center')
  await expect.poll(() => widthOf(center)).toBeGreaterThanOrEqual(360)
  expect(await widthOf(v.locator('aside.right'))).toBeLessThan(720)
  await expect(v.getByRole('separator', { name: 'Resize the right panel' })).toHaveAttribute('aria-valuenow', String(await widthOf(v.locator('aside.right'))))
  expect(saved()).toMatchObject({ sidebarWidth: 480, rightWidth: 720 })
  // the author and date columns give way so the commit subjects stay readable
  const msg = v.locator('.graph-rows .row:not(.wip) .msg').first()
  expect(await widthOf(msg)).toBeGreaterThan(100)
  await expect(msg.locator('.s')).toBeVisible()
  await expect(v.locator('.cols .c-author')).toBeHidden()
})

test('commit form: a tall summary field and a six-line description that grows vertically', async () => {
  const summary = v.getByPlaceholder('Summary', { exact: true })
  const description = v.getByPlaceholder('Description', { exact: true })
  await expect(v.getByLabel('Commit message', { exact: true })).toHaveAttribute('placeholder', 'Summary')
  expect((await summary.boundingBox())!.height).toBeGreaterThanOrEqual(42)
  expect(await summary.evaluate((e) => getComputedStyle(e).fontSize)).toBe('14px')
  await expect(description).toHaveAttribute('rows', '6')
  expect(await description.evaluate((e) => getComputedStyle(e).resize)).toBe('vertical')
  await expect(v.locator('.commit-form')).not.toContainText(/required|optional/i)
})

test('file rows: a status badge with its tooltip and an icon of the file type', async () => {
  writeFileSync(join(fx.beta, 'main.c'), 'int main(void) { return 0; }\n')
  const file = (name: string) => v.locator('aside.right .file', { hasText: name })
  await expect(file('main.c')).toBeVisible()
  await expect(file('file.txt').locator('.st')).toHaveText('M')
  await expect(file('file.txt').locator('.st')).toHaveAttribute('title', 'Modified')
  await expect(file('notes.txt').locator('.st')).toHaveText('U')
  await expect(file('notes.txt').locator('.st')).toHaveAttribute('title', 'Untracked')
  await expect(file('file.txt').locator('.ficon')).toHaveText('≡')
  await expect(file('main.c').locator('.ficon')).toHaveText('C')
  await expect(file('main.c').locator('.ficon')).toHaveCSS('color', 'rgb(81, 154, 186)') // --icon-c
  await shot('file-icons')
})

test('diffs are syntax highlighted', async () => {
  await v.locator('aside.right .file', { hasText: 'main.c' }).locator('.path').click()
  const keyword = v.locator('.lines .t span', { hasText: 'return' })
  await expect(keyword).toHaveCSS('color', 'rgb(124, 188, 244)') // --syn-kw
  await expect(v.locator('.lines .t span', { hasText: 'int' }).first()).toHaveCSS('color', 'rgb(78, 201, 176)') // --syn-ty
  await expect(v.locator('.lines .line.add .t')).toHaveText('int main(void) { return 0; }')
  await shot('highlighted-diff')
})
