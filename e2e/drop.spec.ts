import { expect, test, type Locator, type Page } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchFixture, openRepo, type Fixture } from './fixtures'

test.describe.configure({ mode: 'serial' })

let fx: Fixture
let page: Page
let v: Locator
const row = (subject: string) => v.locator('.graph-rows .row', { has: page.locator('.s', { hasText: new RegExp(`^${subject}$`) }) })
const git = (...args: string[]) => fx.git(fx.alpha, ...args).trim()
const menuOn = async (subject: string) => {
  await row(subject).click({ button: 'right' })
  const menu = page.getByRole('menu', { name: /Actions on commit/ })
  await expect(menu).toBeVisible()
  return menu
}

test.beforeAll(async () => {
  fx = await launchFixture()
  page = fx.page
  git('push', 'origin', 'main')
  // alpha: main is pushed up to "second alpha"; two more commits are local.
  for (const f of ['one', 'two']) {
    writeFileSync(join(fx.alpha, `${f}.txt`), `${f}\n`)
    git('add', '.')
    git('commit', '-q', '-m', `local ${f}`)
  }
  v = await openRepo(page, 'alpha')
  await expect(row('local two')).toBeVisible()
})
test.afterAll(async () => {
  await fx?.close()
})

test('a pushed commit cannot be dropped', async () => {
  const menu = await menuOn('second alpha')
  const item = menu.getByRole('menuitem', { name: 'Drop this commit' })
  await expect(item).toBeDisabled()
  await expect(item).toHaveAttribute('title', /Already pushed/)
  await page.keyboard.press('Escape')
})

test('drop an unpushed commit, then Ctrl+Z brings it back', async () => {
  const before = git('rev-parse', 'HEAD')
  const menu = await menuOn('local one')
  await menu.getByRole('menuitem', { name: 'Drop this commit' }).click()
  const dialog = page.getByRole('dialog', { name: /^Drop [0-9a-f]{7} from main\?/ })
  await expect(dialog).toContainText('Undo (Ctrl+Z) brings it back')
  await dialog.getByRole('button', { name: 'Drop commit' }).click()
  await expect(row('local one')).toHaveCount(0)
  await expect(row('local two')).toBeVisible()
  expect(git('log', '--format=%s', '-3')).toBe('local two\nsecond alpha\ninit alpha')
  await expect(v.getByRole('button', { name: 'Undo', exact: true })).toHaveAttribute('title', /Undo Drop /)
  await v.locator('.graph-rows .row').first().click()
  await page.keyboard.press('Control+z')
  await expect(row('local one')).toBeVisible()
  expect(git('rev-parse', 'HEAD')).toBe(before)
})
