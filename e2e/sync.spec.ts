import { expect, test, type Locator, type Page } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchFixture, openRepo, type Fixture } from './fixtures'

test.describe.configure({ mode: 'serial' })

let fx: Fixture
let page: Page
let v: Locator
const row = (subject: string) => v.locator('.graph-rows .row', { has: page.locator('.s', { hasText: subject }) })
const summary = () => v.locator('.sync-sum')

test.beforeAll(async () => {
  fx = await launchFixture()
  page = fx.page
  v = await openRepo(page, 'alpha') // main: init alpha (pushed) -> second alpha (local only)
})
test.afterAll(async () => {
  await fx?.close()
})

test('a local commit shows the not-pushed state; pushing clears it', async () => {
  await expect(row('second alpha').locator('.sync-chip.out')).toHaveAccessibleName('Not pushed yet')
  await expect(row('init alpha').locator('.sync-chip')).toHaveCount(0)
  await expect(summary()).toHaveText('↑ 1 not pushed')
  writeFileSync(join(fx.alpha, 'b.txt'), 'b\n')
  fx.git(fx.alpha, 'add', '.')
  fx.git(fx.alpha, 'commit', '-m', 'local two')
  await expect(row('local two').locator('.sync-chip.out')).toBeVisible()
  await expect(summary()).toHaveText('↑ 2 not pushed')
  await expect(row('local two').locator('.lanes path[stroke-dasharray]')).not.toHaveCount(0)
  await summary().getByRole('button', { name: /not pushed/ }).click()
  await expect(row('local two')).toHaveClass(/sel/)
  await v.getByRole('button', { name: /Push/ }).click()
  await expect(v.locator('.sync-chip')).toHaveCount(0)
  await expect(summary()).toHaveCount(0)
})

test('a commit pushed from another clone shows the not-pulled state after Fetch; Pull clears it', async () => {
  // A branch that no remote has keeps a not-pushed commit in the picture.
  fx.git(fx.alpha, 'switch', '-q', '-c', 'topic')
  writeFileSync(join(fx.alpha, 't.txt'), 't\n')
  fx.git(fx.alpha, 'add', '.')
  fx.git(fx.alpha, 'commit', '-m', 'topic work')
  fx.git(fx.alpha, 'switch', '-q', 'main')
  const other = join(fx.root, 'other')
  fx.git(fx.root, 'clone', '-q', fx.remote, other)
  writeFileSync(join(other, 'r.txt'), 'r\n')
  fx.git(other, 'add', '.')
  fx.git(other, 'commit', '-m', 'remote work')
  fx.git(other, 'push', '-q')
  await v.getByRole('button', { name: /Fetch/ }).click()
  await expect(row('remote work').locator('.sync-chip.in')).toHaveAccessibleName('Not pulled yet')
  await expect(row('remote work').locator('.sync-chip.in')).toHaveAttribute('title', 'Not pulled yet (on origin/main)')
  await expect(row('topic work').locator('.sync-chip.out')).toBeVisible()
  await expect(summary()).toHaveText('↑ 1 not pushed · ↓ 1 to pull')
  await summary().getByRole('button', { name: /to pull/ }).click()
  await expect(row('remote work')).toHaveClass(/sel/)
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.mouse.move(600, 10)
  await page.screenshot({ path: 'e2e-artifacts/graph-sync.png' })
  await v.getByRole('button', { name: /Pull/ }).click()
  await expect(v.locator('.sync-chip.in')).toHaveCount(0)
  await expect(summary()).toHaveText('↑ 1 not pushed')
})
