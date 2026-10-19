import { expect, test, type Locator, type Page } from '@playwright/test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { FAKE_MESSAGE, launchFixture, openRepo, type Fixture } from './fixtures'

test.describe.configure({ mode: 'serial' })

let fx: Fixture
let page: Page
let v: Locator
const git = (...args: string[]) => fx.git(fx.alpha, ...args).trim()
const pill = (name: string) => v.locator('.graph-rows .ref', { hasText: new RegExp(`^${name}$`) })
const side = (name: string) => v.locator('.side-item', { has: page.getByRole('button', { name, exact: true }) })
const menu = () => page.getByRole('dialog', { name: /What to do with/ })

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
  // alpha: main = init -> second (edits a.txt). From init: feature/y adds y.txt, feature/z adds z.txt,
  // feature/c edits a.txt (conflicts with main), behind stays at init.
  for (const [branch, file, content] of [
    ['feature/y', 'y.txt', 'y\n'],
    ['feature/z', 'z.txt', 'z\n'],
    ['feature/c', 'a.txt', 'one\nother\n']
  ]) {
    git('switch', '-q', '-c', branch, 'HEAD~1')
    writeFileSync(join(fx.alpha, file), content)
    git('add', '.')
    git('commit', '-q', '-m', `feat: ${branch}`)
    git('switch', '-q', 'main')
  }
  git('branch', 'behind', 'HEAD~1')
  writeFileSync(join(fx.alpha, 'a.txt'), 'one\ntwo\nlocal\n') // uncommitted
  v = await openRepo(page, 'alpha')
  await expect(pill('feature/y')).toBeVisible()
})
test.afterAll(async () => {
  await fx?.close()
})

test('drop a branch on main: preview, Claude advice, rebase with auto-stash', async () => {
  await drag(pill('feature/y'), pill('main'))
  await expect(menu()).toContainText('Merge feature/y into main')
  await expect(menu()).toContainText('1 commit to integrate')
  await expect(menu().getByRole('button', { name: /Fast-forward/ })).toBeDisabled()
  await expect(menu()).toContainText('diverged')
  await expect(menu().locator('.ok-box')).toContainText('No conflict expected')
  await expect(menu().getByLabel(/Stash the 1 local change/)).toBeChecked()
  await menu().getByRole('button', { name: 'Ask Claude: merge or rebase?' }).click()
  await expect(menu().locator('.claude-box')).toContainText(FAKE_MESSAGE)
  await page.screenshot({ path: 'e2e-artifacts/drag-merge.png' })
  await menu().getByRole('button', { name: /Rebase main onto feature\/y/ }).click()
  await expect.poll(() => git('rev-parse', 'main~1')).toBe(git('rev-parse', 'feature/y'))
  expect(git('log', '-1', '--format=%s', 'main')).toBe('second alpha')
  expect(readFileSync(join(fx.alpha, 'a.txt'), 'utf8')).toBe('one\ntwo\nlocal\n')
})

test('drop in the sidebar: merge with a message written by Claude', async () => {
  await drag(side('feature/z'), side('main'))
  await menu().getByRole('button', { name: /Merge feature\/z into main/ }).click()
  await menu().getByRole('button', { name: 'Write with Claude' }).click()
  await expect(menu().getByLabel('Merge commit message')).toHaveValue(FAKE_MESSAGE)
  await menu().getByRole('button', { name: 'Merge', exact: true }).click()
  await expect.poll(() => git('log', '-1', '--format=%s')).toBe(FAKE_MESSAGE)
  expect(git('rev-list', '--parents', '-n1', 'HEAD').split(' ')).toHaveLength(3)
  expect(readFileSync(join(fx.alpha, 'a.txt'), 'utf8')).toBe('one\ntwo\nlocal\n')
})

test('fast-forward a branch that is behind, without checking it out', async () => {
  await drag(side('main'), side('behind'))
  await menu().getByRole('button', { name: /Fast-forward/ }).click()
  await expect.poll(() => git('rev-parse', 'behind')).toBe(git('rev-parse', 'main'))
  expect(git('branch', '--show-current')).toBe('main')
})

test('a predicted conflict: the merge stops, the banner aborts it', async () => {
  git('checkout', '--', 'a.txt')
  await expect(v.locator('.row.wip')).toHaveCount(0)
  const before = git('rev-parse', 'HEAD')
  await drag(pill('feature/c'), pill('main'))
  await expect(menu().locator('.warn-box')).toContainText('Likely conflict in a.txt')
  await menu().getByRole('button', { name: /Merge feature\/c into main/ }).click()
  await menu().getByRole('button', { name: 'Merge', exact: true }).click()
  await expect(v.locator('.op-banner')).toContainText('Merge in progress')
  await v.locator('.op-banner').getByRole('button', { name: 'Abort merge' }).click()
  await expect(v.locator('.op-banner')).toHaveCount(0)
  expect(git('rev-parse', 'HEAD')).toBe(before)
  expect(git('status', '--porcelain')).toBe('')
})
