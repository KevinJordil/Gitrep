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

const back = async () => {
  const b = v.getByRole('button', { name: 'History', exact: true })
  if (await b.isVisible()) await b.click()
  await v.locator('.row.wip').click()
}
const reset = async () => {
  writeFileSync(join(fx.beta, 'file.txt'), MODIFIED)
  await refresh()
}

test('CRLF files keep their line endings and the absence of a final newline', async () => {
  await back()
  writeFileSync(join(fx.beta, 'crlf.txt'), 'a\r\nb\r\nc')
  await refresh()
  await open('crlf.txt')
  await edit().click()
  await typeFirst('X')
  await page.keyboard.press('Enter')
  // Pasted text takes the file's line break too.
  await editor().evaluate((el) => {
    const data = new DataTransfer()
    data.setData('text/plain', 'p\nq')
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  })
  await page.keyboard.press('Control+s')
  await expect(page.locator('.toast', { hasText: 'Saved crlf.txt' })).toBeVisible()
  expect(readFileSync(join(fx.beta, 'crlf.txt')).toString('latin1')).toBe('X\r\np\r\nqa\r\nb\r\nc')
})

test('the gutter marks a file against HEAD even when part of it is staged', async () => {
  await back()
  await reset()
  fx.git(fx.beta, 'add', 'file.txt')
  writeFileSync(join(fx.beta, 'file.txt'), lines(20, { 3: 'line 3 CHANGED', 10: 'line 10 CHANGED', 15: 'line 15 CHANGED' }))
  await refresh()
  await open('file.txt')
  await edit().click()
  await expect(v.locator('.cm-change-gutter .cm-chg')).toHaveCount(3)
  await v.getByRole('button', { name: 'Diff', exact: true }).click()
  fx.git(fx.beta, 'reset', '-q', 'file.txt')
  await reset()
})

test('closing a tab with unsaved edits asks about the edits only after the tab close is confirmed', async () => {
  await back()
  await open('file.txt')
  await edit().click()
  await typeFirst('tab ')
  await page.getByRole('button', { name: 'Close beta' }).click()
  const close = page.getByRole('dialog', { name: 'Close beta?' })
  await close.getByRole('button', { name: 'Close tab' }).click()
  const leave = page.getByRole('dialog', { name: 'Discard your unsaved edits to file.txt?' })
  await leave.getByRole('button', { name: 'Discard' }).waitFor() // asked after the confirmation
  await leave.getByRole('button', { name: 'Cancel' }).click()
  await expect(editor()).toContainText('tab line 1')
  await expect(v.getByText('Unsaved')).toBeVisible()
  await undoButton().click() // still registered: repository Undo is refused
  const refused = page.locator('.toast', { hasText: 'Save or discard your edits to file.txt first.' })
  await expect(refused).toBeVisible()
  await refused.getByRole('button', { name: 'Dismiss notification' }).click()
  await page.getByRole('button', { name: 'Close beta' }).click()
  await close.getByRole('button', { name: 'Cancel' }).click() // no edit question when the close is cancelled
  await expect(leave).toBeHidden()
  await v.getByRole('button', { name: 'Revert edits' }).click()
  await v.getByRole('button', { name: 'Diff', exact: true }).click()
})

test('a dirty editor stays open when the file no longer has changes in git', async () => {
  await back()
  await reset()
  await page.evaluate(() => (window.confirm = () => true))
  await open('file.txt')
  await edit().click()
  await typeFirst('kept ')
  await v.getByRole('button', { name: 'Discard changes to file.txt' }).click()
  await expect(v.locator('.editor-banner', { hasText: 'This file no longer has changes in git: your edits are kept here. Save writes them back only when the file still exists (if it was deleted, copy your edits before leaving).' })).toBeVisible()
  await expect(editor()).toContainText('kept line 1')
  await v.getByRole('button', { name: 'Revert edits' }).click()
  await v.getByRole('button', { name: 'Diff', exact: true }).click()
  await reset()
})

test('the disk changing: a clean editor follows it, one with edits asks (Reload / Keep mine)', async () => {
  await back()
  await open('file.txt')
  await edit().click()
  await expect(editor()).toContainText('line 3 CHANGED')
  writeFileSync(join(fx.beta, 'file.txt'), 'outside one\n')
  await refresh()
  await expect(editor()).toContainText('outside one')
  await expect(v.getByText('Unsaved')).toBeHidden()
  await typeFirst('mine ')
  writeFileSync(join(fx.beta, 'file.txt'), 'outside two\n')
  await refresh()
  await expect(v.locator('.editor-banner', { hasText: 'Changed on disk' })).toBeVisible()
  await v.getByRole('button', { name: 'Reload (lose my edits)' }).click()
  await expect(editor()).toContainText('outside two')
  await expect(editor()).not.toContainText('mine')
  await typeFirst('mine ')
  writeFileSync(join(fx.beta, 'file.txt'), 'outside three\n')
  await refresh()
  await v.getByRole('button', { name: 'Keep mine' }).click()
  await page.getByRole('dialog', { name: 'Overwrite the newer version on disk?' }).getByRole('button', { name: 'Keep mine' }).click()
  await expect(v.getByText('Unsaved')).toBeVisible()
  await v.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.locator('.toast', { hasText: 'Saved file.txt' })).toBeVisible()
  expect(read('file.txt')).toBe('mine outside two\n')
})

test('repository Undo is refused while an editor has unsaved edits; the editor is labelled and Escape then Tab leaves it', async () => {
  await expect(undoButton()).toHaveAttribute('title', 'Undo Edit file.txt')
  await expect(page.getByRole('textbox', { name: 'Edit file.txt' })).toBeVisible()
  await typeFirst('more ')
  await undoButton().click()
  await expect(page.locator('.toast', { hasText: 'Save or discard your edits to file.txt first.' })).toBeVisible()
  await page.keyboard.press('Escape')
  await page.keyboard.press('Tab')
  expect(await page.evaluate(() => !!document.activeElement?.closest('.cm-content'))).toBe(false)
  await v.getByRole('button', { name: 'Revert edits' }).click()
})

test('closing the window with unsaved edits asks first', async () => {
  await editor().click()
  await page.keyboard.type('unsaved ')
  await fx.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
  const dialog = page.getByRole('dialog', { name: 'Discard your unsaved edits to file.txt?' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(editor()).toContainText('unsaved')
  expect(await fx.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1)
  await fx.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
  await dialog.getByRole('button', { name: 'Discard' }).click().catch(() => undefined) // the window closes under the click
  await expect.poll(() => fx.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length).catch(() => 0)).toBe(0)
})
