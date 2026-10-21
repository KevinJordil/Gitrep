import { expect, test, type Locator, type Page } from '@playwright/test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchFixture, lines, openRepo, type Fixture } from './fixtures'

test.describe.configure({ mode: 'serial' })

let fx: Fixture
let page: Page
let v: Locator
const MODIFIED = lines(20, { 3: 'line 3 CHANGED', 15: 'line 15 CHANGED' })
const read = (f: string) => readFileSync(join(fx.beta, f), 'utf8')
// The window gaining focus reloads the repository (files written by the test are not watched).
const refresh = () => page.evaluate(() => window.dispatchEvent(new Event('focus')))
const undoButton = () => v.getByRole('button', { name: 'Undo', exact: true })
const open = (name: string) => v.locator('.file', { hasText: name }).getByRole('button', { name: new RegExp(name.replace('.', '\\.')) }).first().click()
const editor = () => v.locator('.cm-content')
const edit = () => v.getByRole('button', { name: 'Edit', exact: true })
const typeFirst = async (text: string) => {
  await editor().click()
  await page.keyboard.press('Control+Home')
  await page.keyboard.type(text)
}

test.beforeAll(async () => {
  fx = await launchFixture()
  page = fx.page
  v = await openRepo(page, 'beta')
})
test.afterAll(async () => {
  await fx?.close()
})

test('edit a changed file, save with Ctrl+S, then Undo from the toolbar', async () => {
  await open('file.txt')
  await expect(v.locator('.hunk').first()).toBeVisible()
  await edit().click()
  await expect(editor()).toContainText('line 3 CHANGED')
  await expect(v.locator('.cm-change-gutter .cm-chg')).toHaveCount(2) // lines 3 and 15
  await typeFirst('EDITED ')
  await expect(v.getByText('Unsaved')).toBeVisible()
  expect(read('file.txt')).toBe(MODIFIED) // nothing written yet
  await page.keyboard.press('Control+s')
  await expect(page.locator('.toast', { hasText: 'Saved file.txt' })).toBeVisible()
  await expect(v.getByText('Unsaved')).toBeHidden()
  expect(read('file.txt')).toBe('EDITED ' + MODIFIED)
  await v.getByRole('button', { name: 'Diff', exact: true }).click()
  await expect(v.locator('.line.add', { hasText: 'EDITED line 1' })).toBeVisible()
  await expect(undoButton()).toHaveAttribute('title', 'Undo Edit file.txt')
  await undoButton().click()
  await expect.poll(() => read('file.txt')).toBe(MODIFIED)
})

test('Ctrl+Z inside the editor undoes the typing, not the last repository operation', async () => {
  await edit().click()
  await typeFirst('ABC')
  await page.keyboard.press('Control+s')
  await expect(page.locator('.toast', { hasText: 'Saved file.txt' })).toBeVisible()
  await expect(undoButton()).toHaveAttribute('title', 'Undo Edit file.txt')
  await page.waitForTimeout(700) // CodeMirror merges typing within 500 ms into one undo step
  await page.keyboard.type('XYZ')
  await page.keyboard.press('Control+z')
  await expect(editor()).not.toContainText('XYZ')
  await expect(editor()).toContainText('ABCline 1')
  await expect(v.getByText('Unsaved')).toBeHidden() // back to the saved content
  expect(read('file.txt')).toBe('ABC' + MODIFIED) // the save was not undone
  await expect(undoButton()).toHaveAttribute('title', 'Undo Edit file.txt')
  await v.getByRole('button', { name: 'Diff', exact: true }).click()
  await undoButton().click()
  await expect.poll(() => read('file.txt')).toBe(MODIFIED)
})

test('unsaved edits: another file asks first, Cancel keeps the editor, Discard leaves', async () => {
  await edit().click()
  await typeFirst('keep me ')
  await open('notes.txt')
  const dialog = page.getByRole('dialog', { name: 'Discard your unsaved edits to file.txt?' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toBeHidden()
  await expect(editor()).toContainText('keep me line 1')
  await open('notes.txt')
  await dialog.getByRole('button', { name: 'Discard' }).click()
  await expect(v.locator('.pane-head .mono', { hasText: 'notes.txt' })).toBeVisible()
  await expect(editor()).toHaveCount(0)
  expect(read('file.txt')).toBe(MODIFIED)
})

test('the file changed on disk: refusal and Reload from disk', async () => {
  await open('file.txt')
  await edit().click()
  await typeFirst('mine ')
  writeFileSync(join(fx.beta, 'file.txt'), 'external\n')
  await page.keyboard.press('Control+s')
  const toast = page.locator('.toast', { hasText: 'The file changed on disk since you opened it.' })
  await expect(toast).toBeVisible()
  expect(read('file.txt')).toBe('external\n')
  await toast.getByRole('button', { name: 'Reload from disk' }).click()
  await expect(editor()).toContainText('external')
  await expect(editor()).not.toContainText('mine')
  await expect(v.getByText('Unsaved')).toBeHidden()
})

test('Edit is disabled with the reason when the file cannot be edited, and absent from commit diffs', async () => {
  writeFileSync(join(fx.beta, 'bin.dat'), Buffer.from([0xff, 0xfe, 0x00, 0x01]))
  await refresh()
  await open('bin.dat')
  await expect(edit()).toBeDisabled()
  await expect(edit()).toHaveAttribute('title', /UTF-8/)
  await v.getByRole('button', { name: 'History', exact: true }).click()
  await v.locator('.row', { hasText: 'add other' }).first().click()
  await v.locator('aside.right .file', { hasText: 'other.txt' }).click()
  await expect(v.locator('.pane-head .mono', { hasText: 'other.txt' })).toBeVisible()
  await expect(edit()).toHaveCount(0)
})

test('screenshot: the editor with its gutter markers', async () => {
  writeFileSync(join(fx.beta, 'file.txt'), MODIFIED)
  await refresh()
  await v.getByRole('button', { name: 'History', exact: true }).click()
  await v.locator('.row.wip').click()
  await open('file.txt')
  await edit().click()
  await expect(v.locator('.cm-change-gutter .cm-chg')).toHaveCount(2)
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.mouse.move(0, 0)
  await page.screenshot({ path: 'e2e-artifacts/file-editor.png' })
})
