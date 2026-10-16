import { expect, test, type Locator, type Page } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchFixture, openRepo, type Fixture } from './fixtures'

test.describe.configure({ mode: 'serial' })

let fx: Fixture
let page: Page
let v: Locator
const git = (...args: string[]) => fx.git(fx.alpha, ...args).trim()
const banner = () => v.locator('.op-banner')
const confirms = () => page.evaluate(() => (window as unknown as { __confirms: string[] }).__confirms)
const answer = (b: boolean) => page.evaluate((x) => ((window as unknown as { __answer: boolean }).__answer = x), b)
const cherryPick = async () => {
  await v.locator('.graph-rows .row', { hasText: 'feat: other a' }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Cherry-pick onto main' }).click()
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
  // alpha: feature/c rewrites a.txt from init, main rewrote it too ("second alpha"): a cherry-pick conflicts.
  git('switch', '-q', '-c', 'feature/c', 'HEAD~1')
  writeFileSync(join(fx.alpha, 'a.txt'), 'one\nother\n')
  git('commit', '-q', '-am', 'feat: other a')
  git('switch', '-q', 'main')
  v = await openRepo(page, 'alpha')
})
test.afterAll(async () => {
  await fx?.close()
})

test('a conflicting cherry-pick shows the banner; Abort restores main', async () => {
  const before = git('rev-parse', 'HEAD')
  await cherryPick()
  await expect(banner()).toContainText('Cherry-pick in progress')
  await expect(banner()).toContainText('1 conflicted file: a.txt')
  await expect(page.locator('.toast', { hasText: 'Stopped on conflicts' })).toBeVisible()
  await expect(banner().getByRole('button', { name: 'Continue' })).toBeDisabled()
  await expect(v.locator('.fgroup', { hasText: 'Conflicts' })).toContainText('a.txt')
  await page.screenshot({ path: 'e2e-artifacts/conflict-banner.png' })
  await banner().getByRole('button', { name: 'Abort cherry-pick' }).click()
  await expect(banner()).toHaveCount(0)
  expect(git('rev-parse', 'HEAD')).toBe(before)
  expect(git('status', '--porcelain')).toBe('')
  expect(await confirms()).toEqual([])
})

test('aborting after staging a resolution asks first; declining keeps the operation', async () => {
  const before = git('rev-parse', 'HEAD')
  await cherryPick()
  await expect(banner()).toContainText('a.txt')
  writeFileSync(join(fx.alpha, 'a.txt'), 'one\ntwo\nother\n')
  await v.getByRole('button', { name: 'Stage a.txt' }).click()
  await expect(banner()).toContainText('no conflicts left')
  await answer(false)
  await banner().getByRole('button', { name: 'Abort cherry-pick' }).click()
  await expect.poll(confirms).toEqual(['Abort the cherry-pick and discard the conflict resolutions made so far?'])
  await expect(banner()).toContainText('Cherry-pick in progress')
  await answer(true)
  await banner().getByRole('button', { name: 'Abort cherry-pick' }).click()
  await expect(banner()).toHaveCount(0)
  expect(git('rev-parse', 'HEAD')).toBe(before)
  expect(git('status', '--porcelain')).toBe('')
})

test('resolve, stage, then Continue completes the cherry-pick', async () => {
  await cherryPick()
  await expect(banner()).toContainText('a.txt')
  writeFileSync(join(fx.alpha, 'a.txt'), 'one\ntwo\nother\n')
  await v.getByRole('button', { name: 'Stage a.txt' }).click()
  await expect(banner()).toContainText('no conflicts left')
  await banner().getByRole('button', { name: 'Continue' }).click()
  await expect(banner()).toHaveCount(0)
  expect(git('log', '-1', '--format=%s')).toBe('feat: other a')
  expect(git('status', '--porcelain')).toBe('')
})
