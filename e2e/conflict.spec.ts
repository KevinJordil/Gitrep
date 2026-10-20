import { expect, test, type Locator, type Page } from '@playwright/test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { FAKE_SUMMARY, launchFixture, openRepo, type Fixture } from './fixtures'

test.describe.configure({ mode: 'serial' })

let fx: Fixture
let page: Page
let v: Locator
let start: string
const git = (...args: string[]) => fx.git(fx.alpha, ...args).trim()
const read = (f: string) => readFileSync(join(fx.alpha, f), 'utf8')
const refresh = () => page.evaluate(() => window.dispatchEvent(new Event('focus')))
const banner = () => v.locator('.op-banner')
const panel = () => v.locator('aside.right')
const result = () => v.getByRole('textbox', { name: 'Result' })
const side = (name: string) => v.getByRole('region', { name })
const confirms = () => page.evaluate(() => (window as unknown as { __confirms: string[] }).__confirms)
const answer = (b: boolean) => page.evaluate((x) => ((window as unknown as { __answer: boolean }).__answer = x), b)
const pill = (name: string) => v.locator('.graph-rows .ref', { hasText: new RegExp(`^${name}$`) })
const menu = () => page.getByRole('dialog', { name: /What to do with/ })
const cherryPick = async () => {
  await v.locator('.graph-rows .row', { hasText: 'feat: other a' }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Cherry-pick onto main' }).click()
}
// main back where it started (outside GitRep, like a terminal would).
const reset = async () => {
  git('reset', '-q', '--hard', start)
  await refresh()
  await expect(v.locator('.graph-rows .row', { hasText: 'second alpha' }).locator('.ref.head')).toBeVisible()
}

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
  await page.evaluate(() => {
    const w = window as unknown as { __confirms: string[]; __answer: boolean }
    w.__confirms = []
    w.__answer = true
    window.confirm = (m) => (w.__confirms.push(String(m)), w.__answer)
  })
  // alpha: main = init -> "second alpha" (adds line two). From init, feature/c adds line "other" (conflicts),
  // topic: t1 adds t.txt, t2 adds line "topic" (conflicts), t3 adds u.txt.
  git('switch', '-q', '-c', 'feature/c', 'HEAD~1')
  writeFileSync(join(fx.alpha, 'a.txt'), 'one\nother\n')
  git('commit', '-q', '-am', 'feat: other a')
  git('switch', '-q', '-c', 'topic', 'main~1')
  for (const [file, content, message] of [
    ['t.txt', 't\n', 't1'],
    ['a.txt', 'one\ntopic\n', 't2'],
    ['u.txt', 'u\n', 't3']
  ]) {
    writeFileSync(join(fx.alpha, file), content)
    git('add', '.')
    git('commit', '-q', '-m', message)
  }
  git('switch', '-q', 'main')
  start = git('rev-parse', 'main')
  v = await openRepo(page, 'alpha')
})
test.afterAll(async () => {
  await fx?.close()
})

test('a conflicting cherry-pick opens the editor: sides by name, take both, mark resolved, continue', async () => {
  const picked = git('rev-parse', '--short=7', 'feature/c')
  await cherryPick()
  await expect(banner()).toContainText(`Cherry-pick in progress of ${picked} onto main · 1 conflicted file`)
  await expect(v.locator('.badge.red')).toHaveText('Conflict 1 of 1')
  await expect(side('main')).toContainText('checked out')
  await expect(side('main').locator('.hl')).toContainText('two')
  await expect(side(picked)).toContainText('feat: other a')
  await expect(side(picked).locator('.hl')).toContainText('other')
  await v.getByRole('button', { name: 'Take both (main first)' }).click()
  await expect(result()).toHaveValue('one\ntwo\nother')
  await expect(v.locator('.cv-tags')).toContainText(picked)
  await expect(v.locator('.badge.grey')).toHaveText('No conflict left')
  await page.screenshot({ path: 'e2e-artifacts/conflict-editor.png' })
  await v.getByRole('button', { name: 'Mark as resolved' }).click()
  await expect(v.locator('.empty')).toContainText('No conflicted file left')
  await panel().getByRole('button', { name: 'Continue cherry-pick' }).click()
  await expect(banner()).toHaveCount(0)
  expect(git('log', '-1', '--format=%s')).toBe('feat: other a')
  expect(read('a.txt')).toBe('one\ntwo\nother\n')
  expect(git('status', '--porcelain')).toBe('')
})

test('after a resolution is staged, abort asks first; declining keeps the operation', async () => {
  await reset()
  const picked = git('rev-parse', '--short=7', 'feature/c')
  await cherryPick()
  await side(picked).getByRole('button', { name: 'Take this block' }).click()
  await expect(result()).toHaveValue('one\nother')
  await v.getByRole('button', { name: 'Mark as resolved' }).click()
  await expect(banner()).toContainText('no conflicts left')
  await answer(false)
  await banner().getByRole('button', { name: 'Abort cherry-pick' }).click()
  await expect.poll(confirms).toEqual(['Abort the cherry-pick and discard the conflict resolutions made so far?'])
  await expect(banner()).toContainText('Cherry-pick in progress')
  await answer(true)
  await banner().getByRole('button', { name: 'Abort cherry-pick' }).click()
  await expect(banner()).toHaveCount(0)
  expect(git('rev-parse', 'HEAD')).toBe(start)
  expect(git('status', '--porcelain')).toBe('')
})

test('Claude suggests a resolution of the block; hand over to Claude Code', async () => {
  await cherryPick()
  await v.getByRole('button', { name: 'Suggest with Claude' }).click()
  await expect(v.locator('.cv-claude')).toContainText(`Claude's suggestion: ${FAKE_SUMMARY}`)
  await expect(v.locator('.cv-claude .badge')).toHaveText('High confidence')
  await page.screenshot({ path: 'e2e-artifacts/conflict-claude.png' })
  await v.getByRole('button', { name: 'Apply to result' }).click()
  await expect(result()).toHaveValue('one\ntwo\nother')
  await expect(v.locator('.cv-tags')).toContainText('Claude')
  await expect(v.locator('.cv-claude')).toContainText(`Conflict 1: ${FAKE_SUMMARY} (high confidence). Both changes are needed.`)
  await v.getByRole('button', { name: 'Hand over to Claude Code' }).click()
  await expect.poll(() => existsSync(fx.terminalLog)).toBe(true)
  const args = readFileSync(fx.terminalLog, 'utf8')
  expect(args.split('\n')[0]).toMatch(/\/claude$/)
  expect(args).toContain('A cherry-pick stopped on conflicts in this git repository.')
  expect(args).toContain('Conflicted files: a.txt')
  await banner().getByRole('button', { name: 'Abort cherry-pick' }).click()
  await expect(banner()).toHaveCount(0)
})

test('a rebase stopped on conflicts: banner with the step, the steps panel, skip the commit', async () => {
  try {
    git('-c', 'merge.conflictStyle=diff3', 'rebase', 'main', 'topic')
  } catch {
    // stops on t2
  }
  await refresh()
  await expect(banner()).toContainText('Rebase in progress of topic onto main · step 2 of 3 · 1 conflicted file')
  await banner().getByRole('button', { name: 'Show conflicts' }).click()
  const steps = panel().locator('.step')
  await expect(steps).toHaveCount(3)
  await expect(steps.nth(0)).toContainText('t1')
  await expect(steps.nth(0)).toContainText('applied')
  await expect(steps.nth(1)).toContainText('t2')
  await expect(steps.nth(1)).toContainText('conflict')
  await expect(steps.nth(2)).toContainText('pending')
  await expect(side('topic')).toContainText('your commit being replayed')
  await expect(side('main')).toContainText('the base you rebase onto')
  await page.screenshot({ path: 'e2e-artifacts/conflict-rebase.png' })
  await banner().getByRole('button', { name: 'Skip this commit' }).click()
  await expect(banner()).toHaveCount(0)
  expect(git('log', '--format=%s', 'topic')).toBe('t3\nt1\nsecond alpha\ninit alpha')
  git('switch', '-q', 'main')
})

test('a drop-menu merge that conflicts opens the editor with a resolution prepared by Claude', async () => {
  await reset()
  await drag(pill('feature/c'), pill('main'))
  await expect(menu().getByLabel(/prepare a resolution with Claude/)).toBeChecked()
  await menu().getByRole('button', { name: /Merge feature\/c into main/ }).click()
  await menu().getByRole('button', { name: 'Merge', exact: true }).click()
  await expect(result()).toHaveValue('one\ntwo\nother')
  await expect(v.locator('.cv-claude')).toContainText('Proposed by Claude, already in the result below')
  await expect(page.locator('.toast', { hasText: 'Claude proposed a resolution for 1 file' })).toBeVisible()
  await v.getByRole('button', { name: 'Mark as resolved' }).click()
  await panel().getByRole('button', { name: 'Continue merge' }).click()
  await expect(banner()).toHaveCount(0)
  expect(git('rev-list', '--parents', '-n1', 'HEAD').split(' ')).toHaveLength(3)
  expect(read('a.txt')).toBe('one\ntwo\nother\n')
})

test('a file changed outside the editor replaces the draft', async () => {
  await reset()
  await cherryPick()
  await v.getByRole('button', { name: 'Take both (main first)' }).click()
  await expect(result()).toHaveValue('one\ntwo\nother')
  writeFileSync(join(fx.alpha, 'a.txt'), 'one\nedited elsewhere\n')
  await refresh()
  await expect(result()).toHaveValue('one\nedited elsewhere')
  await banner().getByRole('button', { name: 'Abort cherry-pick' }).click()
  await expect(banner()).toHaveCount(0)
})
