import { expect, test, type Locator, type Page } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { FAKE_MESSAGE, launchFixture, openRepo, type Fixture } from './fixtures'

test.describe.configure({ mode: 'serial' })

let fx: Fixture
let page: Page
let v: Locator
const row = (subject: string) => v.locator('.graph-rows .row', { has: page.locator('.s', { hasText: subject }) })

test.beforeAll(async () => {
  fx = await launchFixture()
  page = fx.page
  // alpha: main = init -> second (origin/main at init); feature/y = init -> "feat: y"; tag v1.0 on init; a.txt modified.
  const g = (...args: string[]) => fx.git(fx.alpha, ...args)
  g('switch', '-q', '-c', 'feature/y', 'HEAD~1')
  writeFileSync(join(fx.alpha, 'y.txt'), 'y\n')
  g('add', '.')
  g('commit', '-q', '-m', 'feat: y')
  g('switch', '-q', 'main')
  g('tag', 'v1.0', 'HEAD~1')
  writeFileSync(join(fx.alpha, 'a.txt'), 'one\ntwo\nthree\n')
  v = await openRepo(page, 'alpha')
})
test.afterAll(async () => {
  await fx?.close()
})

test('graph: every branch in lanes, ref pills and the WIP row', async () => {
  await expect(row('feat: y')).toBeVisible()
  await expect(row('second alpha')).toBeVisible()
  await expect(row('init alpha')).toBeVisible()
  await expect(v.locator('.row.wip')).toContainText('1 modified file')
  await expect(v.locator('.row.wip path[stroke-dasharray]')).not.toHaveCount(0)
  await expect(row('second alpha').locator('.ref.head')).toHaveText('main')
  await expect(row('feat: y').locator('.ref.local')).toHaveText('feature/y')
  await expect(row('init alpha').locator('.ref.remote')).toHaveText('origin/main')
  await expect(row('init alpha').locator('.ref.tag')).toHaveText('v1.0')
  const dots = await v.locator('.graph-rows .row .lanes').evaluateAll((svgs) => svgs.map((s) => s.lastElementChild?.getAttribute('cx')))
  expect(new Set(dots).size).toBe(2) // main and feature/y in two lanes
  await page.screenshot({ path: 'e2e-artifacts/graph.png' })
})

test('sidebar: branches, stashes and tags; clicking one selects its commit', async () => {
  await expect(v.locator('.side-title', { hasText: 'Tags' })).toContainText('1')
  await v.locator('.side-item', { hasText: 'feature/y' }).getByRole('button', { name: 'feature/y' }).click()
  await expect(row('feat: y')).toHaveClass(/sel/)
  await v.locator('.side-item', { hasText: 'v1.0' }).getByRole('button', { name: 'v1.0' }).click()
  await expect(row('init alpha')).toHaveClass(/sel/)
  await v.locator('.row.wip').click()
  await expect(v.locator('.row.wip')).toHaveClass(/sel/)
})

test('commit details: message, files, read-only diff, Explain with Claude, copy SHA', async () => {
  await row('feat: y').click()
  const panel = v.locator('.commit-panel')
  await expect(panel.locator('.cp-subject')).toHaveText('feat: y')
  await expect(panel).toContainText('E2E Tester')
  await expect(panel.locator('.file', { hasText: 'y.txt' })).toContainText('+1')
  await panel.locator('.file', { hasText: 'y.txt' }).click()
  await expect(v.locator('.hunk')).toHaveCount(1)
  await expect(v.locator('.hunk .line.add')).toHaveText(/y/)
  await expect(v.getByRole('button', { name: /Stage hunk/ })).toHaveCount(0)
  await expect(v.locator('.diff-body .banner')).toHaveCount(0)
  await panel.getByRole('button', { name: 'Explain this commit' }).click()
  await expect(panel.locator('.claude-box')).toContainText(FAKE_MESSAGE)
  await page.screenshot({ path: 'e2e-artifacts/commit-details.png' })
  await panel.getByRole('button', { name: 'Copy the full SHA' }).click()
  const sha = fx.git(fx.alpha, 'rev-parse', 'feature/y').trim()
  await expect.poll(() => fx.app.evaluate(({ clipboard }) => clipboard.readText())).toBe(sha)
  await v.getByRole('button', { name: 'History', exact: true }).click()
  await expect(row('feat: y')).toHaveClass(/sel/)
  await panel.getByRole('button', { name: 'Close the commit details' }).click()
  await expect(v.locator('.right-head')).toContainText('Changes')
})

test('search: highlights, counts, and Enter / arrows select the matches', async () => {
  const box = v.getByPlaceholder('Search: message, author, SHA')
  await box.fill('alpha')
  await expect(v.locator('.searchbox .count')).toHaveText('1 / 2')
  await expect(v.locator('.graph-rows mark')).toHaveCount(2)
  await expect(row('feat: y')).toHaveClass(/dim/)
  await box.press('Enter')
  await expect(row('second alpha')).toHaveClass(/sel/)
  await box.press('Enter')
  await expect(row('init alpha')).toHaveClass(/sel/)
  await expect(v.locator('.searchbox .count')).toHaveText('2 / 2')
  await box.press('ArrowUp')
  await expect(v.locator('.searchbox .count')).toHaveText('1 / 2')
  await box.press('ArrowDown')
  await expect(v.locator('.searchbox .count')).toHaveText('2 / 2')
  await v.getByRole('button', { name: 'Previous match' }).click()
  await expect(row('second alpha')).toHaveClass(/sel/)
  await page.screenshot({ path: 'e2e-artifacts/search.png' })
  await v.getByLabel('Search in').selectOption('sha')
  await box.fill(fx.git(fx.alpha, 'rev-parse', 'feature/y').slice(0, 6))
  await expect(v.locator('.searchbox .count')).toHaveText('1 / 1')
  await box.press('Escape')
  await expect(box).toHaveValue('')
  await expect(v.locator('.row.dim')).toHaveCount(0)
})

test('isolate one branch, hide another, and show them all again', async () => {
  const item = v.locator('.side-item', { hasText: 'feature/y' })
  await item.hover()
  await item.getByRole('button', { name: 'Isolate feature/y' }).click()
  await expect(v.locator('.scope-chip')).toContainText('Only feature/y')
  await expect(row('second alpha')).toHaveCount(0)
  await expect(row('feat: y')).toBeVisible()
  await v.getByRole('button', { name: 'Show all branches' }).click()
  await expect(row('second alpha')).toBeVisible()
  await item.hover()
  await item.getByRole('button', { name: 'Hide feature/y' }).click()
  await expect(row('feat: y')).toHaveCount(0)
  await expect(v.locator('.scope-chip')).toContainText('1 hidden')
  await v.getByRole('button', { name: 'Show hidden branches' }).click()
  await expect(row('feat: y')).toBeVisible()
  await v.getByLabel('Branches shown').selectOption('feature/y')
  await expect(row('second alpha')).toHaveCount(0)
  await v.getByRole('button', { name: 'Show all branches' }).click()
  await expect(row('second alpha')).toBeVisible()
})

test('rapid isolate then show all ends showing all branches', async () => {
  const item = v.locator('.side-item', { hasText: 'feature/y' })
  await item.hover()
  await item.getByRole('button', { name: 'Isolate feature/y' }).click()
  await v.getByRole('button', { name: 'Show all branches' }).click()
  await expect(v.locator('.scope-chip')).toHaveCount(0)
  await expect(row('second alpha')).toBeVisible()
  await expect(row('feat: y')).toBeVisible()
})

test('sidebar: branch actions overlay the end of the row, the name keeps its width', async () => {
  const item = v.locator('.side-item', { hasText: 'feature/y' })
  const name = item.locator('.name')
  const hide = item.getByRole('button', { name: 'Hide feature/y' })
  await page.mouse.move(0, 0)
  await expect(hide).toBeHidden()
  const before = (await name.boundingBox())!.width
  expect(before).toBeGreaterThan((await item.boundingBox())!.width - 60) // no room kept for the buttons
  await item.hover()
  await expect(hide).toBeVisible()
  expect((await name.boundingBox())!.width).toBe(before)
  await expect(name).toHaveAttribute('title', 'feature/y')
  await page.mouse.move(0, 0)
  await expect(hide).toBeHidden()
  await name.focus() // keyboard focus in the row shows the actions too
  await expect(hide).toBeVisible()
  await page.screenshot({ path: 'e2e-artifacts/sidebar-actions.png' })
})
