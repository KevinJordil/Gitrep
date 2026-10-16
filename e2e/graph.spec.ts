import { expect, test, type Locator, type Page } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchFixture, openRepo, type Fixture } from './fixtures'

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
