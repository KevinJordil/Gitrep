import { expect, test } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchFixture, openRepo, type Fixture } from './fixtures'

let fx: Fixture
test.beforeAll(async () => {
  fx = await launchFixture()
})
test.afterAll(async () => fx.close())

test('new nested folders list every file, and a folder at any level can be staged from the menu', async () => {
  for (const [p, c] of [['new/one.txt', '1\n'], ['new/deep/two.txt', '2\n'], ['new/deep/deeper/three.txt', '3\n']]) {
    mkdirSync(join(fx.alpha, p, '..'), { recursive: true })
    writeFileSync(join(fx.alpha, p), c)
  }
  const v = await openRepo(fx.page, 'alpha')
  const unstaged = v.locator('.fgroup', { hasText: /^Unstaged/ })
  await expect(unstaged.locator('.file')).toHaveCount(3)
  await unstaged.locator('.file', { hasText: 'three.txt' }).click({ button: 'right' })
  const menu = fx.page.getByRole('menu')
  await expect(menu.getByRole('menuitem')).toHaveText(['Stage new/deep/deeper/', 'Stage new/deep/', 'Stage new/'])
  await menu.getByRole('menuitem', { name: 'Stage new/deep/', exact: true }).click()
  await expect(v.locator('.fgroup', { hasText: /^Staged/ }).locator('.file')).toHaveCount(2)
  expect(fx.git(fx.alpha, 'diff', '--cached', '--name-only').trim().split('\n').sort()).toEqual(['new/deep/deeper/three.txt', 'new/deep/two.txt'])
  await v.locator('.fgroup', { hasText: /^Staged/ }).locator('.file', { hasText: 'two.txt' }).click({ button: 'right' })
  await fx.page.getByRole('menuitem', { name: 'Unstage new/', exact: true }).click()
  await expect(v.locator('.fgroup', { hasText: /^Staged/ }).locator('.file')).toHaveCount(0)
})
