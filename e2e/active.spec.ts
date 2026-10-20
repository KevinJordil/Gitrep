import { expect, test, type Locator, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchFixture, openRepo, type Fixture } from './fixtures'

test.describe.configure({ mode: 'serial' })

let fx: Fixture
let page: Page
let v: Locator
const row = (subject: string) => v.locator('.graph-rows .row', { has: page.locator('.s', { hasText: subject }) })
const subjects = () => v.locator('.graph-rows .row:not(.wip) .s').allTextContents()
const savedDays = () => JSON.parse(readFileSync(join(fx.root, 'userData', 'config.json'), 'utf8')).settings.activeDays

test.beforeAll(async () => {
  fx = await launchFixture()
  page = fx.page
  // alpha: main = "init alpha" -> "second alpha" (both now), origin/main at init. Branches off init, dated in the past:
  // feature/a: "a one" (3 days ago) -> "a two" (1 day); feature/b: "b one" (2 days); old/quarter: 60 days; old/legacy: 200 days, tag v0.1.
  const branch = (name: string, ...commits: [string, number][]) => {
    fx.git(fx.alpha, 'switch', '-q', '-c', name, 'main~1')
    for (const [subject, days] of commits) fx.gitAt(days, fx.alpha, 'commit', '-q', '--allow-empty', '-m', subject)
  }
  branch('feature/a', ['a one', 3], ['a two', 1])
  branch('feature/b', ['b one', 2])
  branch('old/quarter', ['quarter work', 60])
  branch('old/legacy', ['legacy work', 200])
  fx.git(fx.alpha, 'tag', 'v0.1')
  fx.git(fx.alpha, 'switch', '-q', 'main')
  v = await openRepo(page, 'alpha')
})
test.afterAll(async () => {
  await fx?.close()
})

test('active branches by default, newest commits first across branches', async () => {
  const shown = v.getByLabel('Branches shown')
  await expect(shown).toHaveValue('days:30')
  await expect.poll(subjects).toEqual(['second alpha', 'a two', 'b one', 'a one', 'init alpha'])
  await expect(row('quarter work')).toHaveCount(0)
  await expect(v.locator('.ref.tag')).toHaveCount(0) // v0.1 is only on an old branch
  await page.screenshot({ path: 'e2e-artifacts/active-branches.png' })
})

test('90 days and all branches; the choice is saved', async () => {
  const shown = v.getByLabel('Branches shown')
  await shown.selectOption('days:90')
  await expect(row('quarter work')).toBeVisible()
  await expect(row('legacy work')).toHaveCount(0)
  await expect.poll(savedDays).toBe(90)
  await shown.selectOption('days:0')
  await expect(row('legacy work').locator('.ref.tag')).toHaveText('v0.1')
  await expect.poll(subjects).toEqual(['second alpha', 'a two', 'b one', 'a one', 'quarter work', 'legacy work', 'init alpha'])
  await expect.poll(savedDays).toBe(0)
  await shown.selectOption('days:30')
  await expect(row('quarter work')).toHaveCount(0)
})

test('isolating an old branch shows it, showing all goes back to the active ones', async () => {
  await v.getByLabel('Branches shown').selectOption('old/legacy')
  await expect(v.locator('.scope-chip')).toContainText('Only old/legacy')
  await expect.poll(subjects).toEqual(['legacy work', 'init alpha'])
  await v.getByRole('button', { name: 'Show all branches' }).click()
  await expect(row('a two')).toBeVisible()
  await expect(row('legacy work')).toHaveCount(0)
})
