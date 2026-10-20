import { expect, test, type Locator, type Page } from '@playwright/test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchFixture, openRepo, type Fixture } from './fixtures'

test.describe.configure({ mode: 'serial' })

let fx: Fixture
let page: Page
let v: Locator
const git = (...args: string[]) => fx.git(fx.alpha, ...args).trim()
const read = (f: string) => readFileSync(join(fx.alpha, f), 'utf8')
const confirms = () => page.evaluate(() => (window as unknown as { __confirms: string[] }).__confirms)
// The window gaining focus reloads the repository (files written by the test are not watched).
const refresh = () => page.evaluate(() => window.dispatchEvent(new Event('focus')))
const undoButton = () => v.getByRole('button', { name: 'Undo', exact: true })
const side = (name: string) => v.locator('.side-item', { has: page.getByRole('button', { name, exact: true }) })
// Undo is ready for the next shortcut once the toolbar shows the expected label.
const readyToUndo = async (label: string) => {
  await expect(undoButton()).toHaveAttribute('title', `Undo ${label}`)
  await expect(undoButton()).toBeEnabled()
}

test.beforeAll(async () => {
  fx = await launchFixture()
  page = fx.page
  await page.evaluate(() => {
    const w = window as unknown as { __confirms: string[] }
    w.__confirms = []
    window.confirm = (m) => (w.__confirms.push(String(m)), true)
  })
  // alpha: "merged" points at an ancestor of main, "side" has a commit main does not have.
  git('branch', 'merged', 'HEAD~1')
  git('switch', '-q', '-c', 'side', 'HEAD~1')
  writeFileSync(join(fx.alpha, 's.txt'), 's\n')
  git('add', '.')
  git('commit', '-q', '-m', 'feat: side')
  git('switch', '-q', 'main')
  v = await openRepo(page, 'alpha')
})
test.afterAll(async () => {
  await fx?.close()
})

test('commit, then Undo from the toolbar and Redo from the toast', async () => {
  const before = git('rev-parse', 'HEAD')
  await expect(undoButton()).toBeDisabled()
  writeFileSync(join(fx.alpha, 'a.txt'), 'one\ntwo\nthree\n')
  await refresh()
  await v.getByRole('button', { name: 'Stage a.txt' }).click()
  await v.getByPlaceholder('Summary', { exact: true }).fill('feat: three')
  await v.getByRole('button', { name: 'Commit to main' }).click()
  await expect.poll(() => git('log', '-1', '--format=%s')).toBe('feat: three')
  await readyToUndo('Commit "feat: three"')
  await undoButton().click()
  const toast = page.locator('.toast', { hasText: 'Commit "feat: three" undone' })
  await expect(toast).toContainText(`main is back at ${before.slice(0, 7)}`)
  expect(git('rev-parse', 'HEAD')).toBe(before)
  expect(git('diff', '--cached', '--name-only')).toBe('a.txt')
  await page.screenshot({ path: 'e2e-artifacts/undo-toast.png' })
  await toast.getByRole('button', { name: 'Redo' }).click()
  await expect.poll(() => git('log', '-1', '--format=%s')).toBe('feat: three')
  await expect(page.locator('.toast', { hasText: 'Commit "feat: three" redone' })).toBeVisible()
  await expect(v.getByRole('button', { name: 'Redo', exact: true })).toBeDisabled()
})

test('Ctrl+Z undoes a branch creation, Ctrl+Shift+Z redoes it', async () => {
  await v.getByRole('button', { name: 'Branch', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Branch name').fill('topic')
  await dialog.getByRole('button', { name: 'Create branch' }).click()
  await expect.poll(() => git('branch', '--show-current')).toBe('topic')
  await readyToUndo('Create branch topic')
  await v.locator('.graph-rows .row').first().click()
  await page.keyboard.press('Control+z')
  await expect.poll(() => git('branch', '--show-current')).toBe('main')
  await expect.poll(() => git('branch', '--list', 'topic')).toBe('') // deleted right after the switch
  await expect(v.getByRole('button', { name: 'Redo', exact: true })).toBeEnabled()
  await page.keyboard.press('Control+Shift+z')
  await expect.poll(() => git('branch', '--show-current')).toBe('topic')
  await readyToUndo('Create branch topic')
  await page.keyboard.press('Control+z')
  await expect.poll(() => git('branch', '--show-current')).toBe('main')
})

test('discard a file, then undo brings its content back', async () => {
  writeFileSync(join(fx.alpha, 'a.txt'), 'one\ntwo\nthree\ndiscard me\n')
  await refresh()
  await v.locator('.row.wip').click() // back to the changes panel
  await v.getByRole('button', { name: 'Discard changes to a.txt' }).click()
  await expect.poll(() => read('a.txt')).toBe('one\ntwo\nthree\n')
  expect((await confirms()).at(-1)).toBe('Discard the changes to a.txt? Ctrl+Z can bring them back while GitRep is open (not for very large changes).')
  await readyToUndo('Discard changes to a.txt')
  await undoButton().click()
  await expect.poll(() => read('a.txt')).toBe('one\ntwo\nthree\ndiscard me\n')
  git('checkout', '--', 'a.txt')
})

test('hard reset with local changes, then undo brings back the commits and the changes', async () => {
  const before = git('rev-parse', 'HEAD')
  writeFileSync(join(fx.alpha, 'a.txt'), 'one\ntwo\nthree\nlocal\n')
  await refresh()
  await expect(v.locator('.row.wip')).toBeVisible()
  await v.locator('.graph-rows .row', { hasText: 'init alpha' }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Reset main here' }).click()
  await page.getByRole('menuitem', { name: /^Hard/ }).click()
  await expect.poll(() => read('a.txt')).toBe('one\n')
  expect((await confirms()).at(-1)).toMatch(/^Reset main to [0-9a-f]{7} and discard all uncommitted changes\? Undo \(Ctrl\+Z\) brings them back/)
  await readyToUndo(`Reset to ${git('rev-parse', '--short=7', 'HEAD')} (hard)`)
  await undoButton().click()
  await expect(page.locator('.toast', { hasText: '(hard) undone' })).toContainText(`main is back at ${before.slice(0, 7)}`)
  expect(git('rev-parse', 'HEAD')).toBe(before)
  expect(read('a.txt')).toBe('one\ntwo\nthree\nlocal\n')
  git('checkout', '--', 'a.txt')
})

test('delete branches from the sidebar, the unmerged one after confirmation; Ctrl+Z restores them', async () => {
  const sideSha = git('rev-parse', 'side')
  await side('merged').hover()
  await side('merged').getByRole('button', { name: 'Delete merged' }).click()
  await expect(page.locator('.toast', { hasText: 'Branch merged deleted' })).toBeVisible()
  expect(git('branch', '--list', 'merged')).toBe('')
  await readyToUndo('Delete branch merged')
  await side('side').hover()
  await side('side').getByRole('button', { name: 'Delete side' }).click()
  await expect.poll(() => git('branch', '--list', 'side')).toBe('')
  expect((await confirms()).at(-1)).toBe('side is not fully merged. Delete it anyway? Ctrl+Z can restore it while GitRep is open.')
  await readyToUndo('Delete branch side')
  await page.keyboard.press('Control+z')
  await expect.poll(() => git('branch', '--list', 'side')).toBe('side')
  expect(git('rev-parse', 'side')).toBe(sideSha)
  await readyToUndo('Delete branch merged')
  await page.keyboard.press('Control+z')
  await expect.poll(() => git('branch', '--list', 'merged')).toBe('merged')
})

test('drop a stash without confirmation, then undo brings it back', async () => {
  writeFileSync(join(fx.alpha, 'a.txt'), 'one\ntwo\nthree\nstashed\n')
  git('stash', 'push', '-q', '-m', 'to drop')
  await refresh()
  await side('to drop').getByRole('button', { name: 'to drop' }).click()
  const asked = (await confirms()).length
  await v.locator('.stash-actions').getByRole('button', { name: 'Drop' }).click()
  await expect.poll(() => git('stash', 'list')).toBe('')
  expect((await confirms()).length).toBe(asked)
  await readyToUndo('Drop stash "to drop"')
  await page.keyboard.press('Control+z')
  await expect.poll(() => git('stash', 'list', '--format=%gs')).toBe('On main: to drop')
})

test('Ctrl+Z is ignored while a menu is open', async () => {
  writeFileSync(join(fx.alpha, 'a.txt'), 'one\nmenu\n')
  await refresh()
  await v.getByRole('button', { name: 'Stage a.txt' }).click()
  await v.getByPlaceholder('Summary', { exact: true }).fill('feat: menu')
  await v.getByRole('button', { name: 'Commit to main' }).click()
  await expect.poll(() => git('log', '-1', '--format=%s')).toBe('feat: menu')
  await readyToUndo('Commit "feat: menu"')
  const head = git('rev-parse', 'HEAD')
  await v.locator('.graph-rows .row', { hasText: 'feat: menu' }).click({ button: 'right' })
  await expect(page.getByRole('menu')).toBeVisible()
  await page.keyboard.press('Control+z')
  await page.waitForTimeout(500)
  expect(git('rev-parse', 'HEAD')).toBe(head)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toBeHidden()
  await page.keyboard.press('Control+z')
  await expect.poll(() => git('rev-parse', 'HEAD')).not.toBe(head)
})
