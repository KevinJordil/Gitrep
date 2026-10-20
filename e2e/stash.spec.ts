import { expect, test, type Locator, type Page } from '@playwright/test'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { FAKE_MESSAGE, launchFixture, openRepo, type Fixture } from './fixtures'

test.describe.configure({ mode: 'serial' })

let fx: Fixture
let page: Page
let v: Locator
const git = (...args: string[]) => fx.git(fx.alpha, ...args).trim()
const a = () => readFileSync(join(fx.alpha, 'a.txt'), 'utf8')
const stashItem = (text: string) => v.locator('.side-item', { hasText: text })

test.beforeAll(async () => {
  fx = await launchFixture()
  page = fx.page
  await page.evaluate(() => {
    window.confirm = () => true
  })
  writeFileSync(join(fx.alpha, 'a.txt'), 'one\ntwo\nstashed\n')
  writeFileSync(join(fx.alpha, 'notes.txt'), 'notes\n')
  v = await openRepo(page, 'alpha')
  await expect(v.locator('.row.wip')).toBeVisible()
})
test.afterAll(async () => {
  await fx?.close()
})

test('new stash named by Claude, with the untracked files', async () => {
  await v.getByRole('button', { name: 'Stash', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('button', { name: 'Stash 1 changed file' })).toBeVisible()
  await dialog.getByRole('button', { name: 'Name with Claude' }).click()
  await expect(dialog.getByLabel('Name')).toHaveValue(FAKE_MESSAGE)
  await dialog.getByLabel(/Include untracked files/).check()
  await dialog.getByRole('button', { name: 'Stash 2 changed files' }).click()
  await expect(dialog).toHaveCount(0)
  expect(git('stash', 'list', '--format=%gs')).toBe(`On main: ${FAKE_MESSAGE}`)
  expect(git('status', '--porcelain')).toBe('')
  await expect(stashItem(FAKE_MESSAGE)).toBeVisible()
  await expect(v.locator('.row.wip')).toHaveCount(0)
})

test('stash content: files, diff, details', async () => {
  await stashItem(FAKE_MESSAGE).getByRole('button', { name: FAKE_MESSAGE }).click()
  await expect(v.locator('.pane-head')).toContainText('stash@{0}')
  await expect(v.locator('.fchip')).toHaveCount(2)
  await expect(v.locator('.hunk .line.add')).toContainText('stashed')
  await v.locator('.fchip', { hasText: 'notes.txt' }).click()
  await expect(v.locator('.hunk .line.add')).toContainText('notes')
  await expect(v.locator('.facts')).toContainText('2 files, 1 untracked')
  await page.screenshot({ path: 'e2e-artifacts/stash.png' })
})

test('apply keeps the stash, drop removes it', async () => {
  await v.locator('.stash-actions').getByRole('button', { name: 'Apply' }).click()
  await expect.poll(a).toBe('one\ntwo\nstashed\n')
  expect(existsSync(join(fx.alpha, 'notes.txt'))).toBe(true)
  expect(git('stash', 'list')).not.toBe('')
  git('checkout', '--', 'a.txt')
  rmSync(join(fx.alpha, 'notes.txt'))
  await v.locator('.stash-actions').getByRole('button', { name: 'Drop' }).click()
  await expect.poll(() => git('stash', 'list')).toBe('')
  await expect(v.locator('.right-head')).toContainText('Changes') // the view leaves the dropped stash
})

test('pop from the toolbar, then create a branch from a stash', async () => {
  writeFileSync(join(fx.alpha, 'a.txt'), 'one\ntwo\npopped\n')
  git('stash', 'push', '-q', '-m', 'to pop')
  await expect(stashItem('to pop')).toBeVisible()
  await v.getByRole('button', { name: 'Pop', exact: true }).click()
  await expect.poll(a).toBe('one\ntwo\npopped\n')
  await expect(stashItem('to pop')).toHaveCount(0)
  git('stash', 'push', '-q', '-m', 'to branch')
  await stashItem('to branch').getByRole('button', { name: 'to branch' }).click()
  await v.locator('.stash-actions').getByRole('button', { name: 'Create branch…' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Branch name').fill('from-stash')
  await dialog.getByRole('button', { name: 'Create branch' }).click()
  await expect(v.locator('.branch-pill')).toHaveText('from-stash')
  expect(a()).toBe('one\ntwo\npopped\n')
  expect(git('stash', 'list')).toBe('')
})
