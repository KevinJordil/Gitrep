import { expect, test, type Locator, type Page } from '@playwright/test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { FAKE_TOKEN, startFakeForge, type FakeForge } from './fakeForge'
import { launchFixture, openRepo, type Fixture } from './fixtures'

test.describe.configure({ mode: 'serial' })

let fx: Fixture
let forge: FakeForge
let page: Page
let v: Locator
const git = (...args: string[]) => fx.git(fx.alpha, ...args).trim()
const dialog = () => page.getByRole('dialog', { name: 'Review with Claude' })
const accounts = () => page.getByRole('dialog', { name: 'Accounts' })
const gitlabRow = () => accounts().getByRole('region', { name: 'GitLab 127.0.0.1' })
const userData = (f: string) => readFileSync(join(fx.root, 'userData', f), 'utf8')

test.beforeAll(async () => {
  forge = await startFakeForge()
  fx = await launchFixture()
  page = fx.page
  // alpha: feature/mr has one commit and an open merge request on the fake GitLab at 127.0.0.1.
  git('switch', '-q', '-c', 'feature/mr')
  writeFileSync(join(fx.alpha, 'mr.c'), 'int mr;\n')
  git('add', '.')
  git('commit', '-q', '-m', 'feat: mr')
  git('remote', 'set-url', 'origin', `${forge.url}/team/sub/alpha.git`)
  forge.mrs.push({ project: 'team/sub/alpha', iid: 7, title: 'Add mr.c', source: 'feature/mr', target: 'main', author: 'Kim Dubois', sha: git('rev-parse', 'HEAD'), base: git('rev-parse', 'main') })
  v = await openRepo(page, 'alpha')
})
test.afterAll(async () => {
  await fx?.close()
  await forge?.close()
})

test('an unknown host: the user names its forge once, then adds an account from the review dialog', async () => {
  await v.getByRole('button', { name: 'Review', exact: true }).click()
  await expect(dialog()).toContainText('GitRep does not know which forge 127.0.0.1 is.')
  await dialog().getByRole('button', { name: 'GitLab', exact: true }).click()
  await expect(dialog()).toContainText('No GitLab account for 127.0.0.1: add one to find its merge requests and post comments.')
  expect(JSON.parse(userData('config.json')).settings.forgeHosts).toEqual({ '127.0.0.1': 'gitlab' })
  expect(forge.calls).toEqual([]) // nothing is asked of the forge without an account
  await dialog().getByRole('button', { name: 'Accounts…' }).click()
  await expect(gitlabRow().getByLabel('Instance URL')).toHaveValue(forge.url)
  await expect(gitlabRow()).toContainText('Not configured')
  await gitlabRow().getByLabel('Personal access token').fill('wrong-token')
  await gitlabRow().getByRole('button', { name: 'Test connection' }).click()
  await expect(gitlabRow()).toContainText('GitLab (127.0.0.1) rejected the token (401)')
  await gitlabRow().getByLabel('Personal access token').fill(FAKE_TOKEN)
  await gitlabRow().getByRole('button', { name: 'Test connection' }).click()
  await expect(gitlabRow()).toContainText('Connected as @k.dubois')
  await expect(gitlabRow().getByLabel('Personal access token')).toHaveValue('')
  expect(userData('accounts.json')).not.toContain(FAKE_TOKEN)
  expect(userData('config.json')).not.toContain(FAKE_TOKEN)
  await page.screenshot({ path: 'e2e-artifacts/review-accounts.png' })
  await accounts().getByRole('button', { name: 'Done' }).click()
  await expect(dialog().getByRole('status').filter({ hasText: 'Merge request !7' })).toContainText('Merge request !7 is open for this branch on 127.0.0.1“Add mr.c” · target main · by Kim Dubois')
  await expect(dialog().getByLabel('Compare with')).toHaveValue('origin/main')
  await page.screenshot({ path: 'e2e-artifacts/review-detect.png' })
  await dialog().getByRole('button', { name: 'Cancel' }).click()
})

test('the open merge request shows on the toolbar, the sidebar and the branch menu', async () => {
  await expect(v.getByRole('button', { name: /^Review/ }).locator('.mr')).toHaveText('!7')
  const row = v.locator('.side-item', { has: page.getByRole('button', { name: 'feature/mr', exact: true }) })
  await expect(row.locator('.mrtag')).toHaveText('!7')
  await row.click({ button: 'right' })
  await expect(page.getByRole('menuitem', { name: 'Review MR !7 GitLab' })).toBeVisible()
  await page.getByRole('menuitem', { name: 'Review MR !7 GitLab' }).click()
  await expect(dialog().getByLabel('Branch', { exact: true })).toHaveValue('feature/mr')
  await dialog().getByRole('button', { name: 'Cancel' }).click()
})

test('an unrelated settings save neither clears the badge nor asks the forge again', async () => {
  const before = forge.calls.length
  const handle = v.getByRole('separator', { name: 'Resize the sidebar' })
  const width = () => JSON.parse(userData('config.json')).settings.sidebarWidth
  const w = width()
  await handle.focus()
  await page.keyboard.press('ArrowLeft')
  await expect.poll(width).not.toBe(w)
  await page.waitForTimeout(500) // the saved config is read back: the views have reloaded
  await expect(v.getByRole('button', { name: /^Review/ }).locator('.mr')).toHaveText('!7')
  expect(forge.calls.length).toBe(before)
})

test('the titlebar opens the accounts; removing one forgets the request', async () => {
  await page.getByRole('button', { name: 'Accounts', exact: true }).click()
  await expect(accounts().getByRole('region', { name: 'GitHub github.com' })).toContainText('Not configured')
  await gitlabRow().getByRole('button', { name: 'Remove' }).click()
  await expect(gitlabRow()).toContainText('Remove the token for 127.0.0.1?')
  await gitlabRow().getByRole('button', { name: 'Confirm' }).click()
  await expect(gitlabRow()).toContainText('Not configured')
  await accounts().getByRole('button', { name: 'Done' }).click()
  await expect(v.getByRole('button', { name: /^Review/ }).locator('.mr')).toHaveCount(0)
  expect(JSON.parse(userData('accounts.json'))).toEqual([])
})

const finding = (fields: string[], comment: string) => ['=== finding', ...fields, '--- comment', comment, '=== end'].join('\n')
const post = () => v.locator('aside.right')
const progress = () => post().getByRole('status', { name: 'Posting' })

test('merge request mode: an account added from the dialog finds the request, a failed comment is retried alone', async () => {
  // a.txt on feature/mr: line "one" becomes "uno" (a deleted and an added line), "two" stays (a context line).
  writeFileSync(join(fx.alpha, 'a.txt'), 'uno\ntwo\n')
  git('commit', '-q', '-am', 'fix: uno')
  forge.mrs[0].sha = git('rev-parse', 'HEAD')
  writeFileSync(
    join(fx.root, 'review-answer'),
    [
      finding(['severity: critical', 'file: mr.c', 'line: R1', 'title: Global'], 'Avoid a global.'),
      finding(['severity: minor', 'file: a.txt', 'line: L1', 'title: Removed'], 'Why remove one?'),
      finding(['severity: important', 'file: a.txt', 'line: R2', 'title: Context'], 'Two stays.')
    ].join('\n')
  )
  await v.locator('.side-item', { has: page.getByRole('button', { name: 'feature/mr', exact: true }) }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Review with Claude…' }).click()
  await expect(dialog()).toContainText('No GitLab account for 127.0.0.1')
  await expect(dialog().getByRole('radio', { name: /Merge request/ })).toBeDisabled()
  await expect(dialog().getByRole('radio', { name: /My branch/ })).toHaveAttribute('aria-checked', 'true')
  // With the account added from the dialog, the request is found and posting to it is proposed.
  await dialog().getByRole('button', { name: 'Accounts…' }).click()
  await gitlabRow().getByLabel('Personal access token').fill(FAKE_TOKEN)
  await gitlabRow().getByRole('button', { name: 'Test connection' }).click()
  await expect(gitlabRow()).toContainText('Connected as @k.dubois')
  await accounts().getByRole('button', { name: 'Done' }).click()
  await expect(dialog().getByRole('radio', { name: /Merge request/ })).toHaveAttribute('aria-checked', 'true')
  await expect(dialog()).toContainText('Posting as @k.dubois · GitLab')
  await dialog().getByLabel('Compare with').selectOption('main')
  await dialog().getByRole('button', { name: 'Start review' }).click()
  await expect(v.getByRole('region', { name: 'Review' })).toContainText('Reviewing MR !7 feature/mr → main · 3 findings · Default review')
  await expect(post()).toContainText('127.0.0.1')
  await expect(post()).toContainText('team/sub/alpha · posting as @k.dubois')
  await expect(post().getByLabel('Summary comment')).toHaveCount(0)
  await post().getByLabel('Post as a draft review (publish all at once)').uncheck()
  forge.calls.length = 0
  forge.fail.push({ match: '/discussions', status: 400, message: 'line_code can not be blank', times: 1 })
  await page.screenshot({ path: 'e2e-artifacts/review-mr.png' })
  await post().getByRole('button', { name: 'Post 3 comments to MR !7' }).click()
  await expect(progress()).toContainText('2 of 3')
  await expect(progress().locator('.pstep.fail')).toContainText('mr.c:1 · GitLab (127.0.0.1) refused the data (400): line_code can not be blank')
  await page.screenshot({ path: 'e2e-artifacts/review-mr-failed.png' })
  await progress().getByRole('button', { name: 'Retry failed (1)' }).click()
  await expect(progress()).toContainText('3 of 3')
  await expect(progress().getByRole('link', { name: 'Open MR !7 on GitLab' })).toBeVisible()
  const posted = forge.calls.filter((c) => c.method === 'POST').map((c) => [c.path.split('/merge_requests/7')[1], c.body])
  const position = (lines: object) => ({ position_type: 'text', base_sha: forge.mrs[0].base, start_sha: forge.mrs[0].base, head_sha: forge.mrs[0].sha, ...lines })
  expect(posted).toEqual([
    ['/discussions', { body: 'Avoid a global.', position: position({ old_path: 'mr.c', new_path: 'mr.c', new_line: 1 }) }],
    ['/discussions', { body: 'Two stays.', position: position({ old_path: 'a.txt', new_path: 'a.txt', new_line: 2, old_line: 2 }) }],
    ['/discussions', { body: 'Why remove one?', position: position({ old_path: 'a.txt', new_path: 'a.txt', old_line: 1 }) }],
    ['/discussions', { body: 'Avoid a global.', position: position({ old_path: 'mr.c', new_path: 'mr.c', new_line: 1 }) }]
  ])
  expect(posted.some(([path]) => String(path).startsWith('/notes'))).toBe(false) // no summary note
})

test('a draft review on GitLab is published once every note is in; switching mode keeps the edits', async () => {
  await v.getByRole('button', { name: 'Re-run' }).click()
  await expect(post().getByLabel('Post as a draft review (publish all at once)')).toBeChecked()
  await v.getByRole('group', { name: 'Finding: Removed' }).getByRole('button', { name: 'Ignore' }).click()
  await expect(v.getByRole('complementary', { name: 'Findings' })).toContainText('2 of 3 kept')
  await v.getByRole('button', { name: 'Switch to my branch mode' }).click()
  await expect(post()).toContainText('Prepare fixes')
  await expect(v.getByRole('complementary', { name: 'Findings' })).toContainText('2 of 3 kept')
  await v.getByRole('button', { name: 'Switch to MR mode' }).click()
  await expect(post()).toContainText('1 ignored')
  forge.calls.length = 0
  await post().getByRole('button', { name: 'Post 2 comments to MR !7' }).click()
  await expect(progress()).toContainText('3 of 3')
  expect(forge.calls.filter((c) => c.method === 'POST').map((c) => c.path.split('/merge_requests/7')[1])).toEqual(['/draft_notes', '/draft_notes', '/draft_notes/bulk_publish'])
})

test('posting locks the screen and survives a mode switch; a rejected draft note can be skipped, then the draft is published', async () => {
  await v.getByRole('button', { name: 'Re-run' }).click()
  await expect(post().getByLabel('Post as a draft review (publish all at once)')).toBeChecked()
  forge.calls.length = 0
  forge.delay = 300
  forge.fail.push({ match: '/draft_notes', status: 400, message: 'note rejected', times: 1 })
  await post().getByRole('button', { name: 'Post 3 comments to MR !7' }).click()
  await expect(v.getByRole('button', { name: 'Re-run' })).toBeDisabled()
  await expect(v.getByRole('button', { name: 'Exit review' })).toBeDisabled()
  await expect(v.getByRole('button', { name: 'Switch to my branch mode' })).toBeDisabled()
  await expect(v.getByRole('group', { name: 'Finding: Global' }).getByLabel('Comment')).toHaveAttribute('readonly', '')
  await expect(post()).toContainText('Posting uses the text as it was when you clicked Post.')
  await expect(progress()).toContainText('Stopped')
  forge.delay = 0
  await expect(progress().locator('.pstep.fail')).toContainText('mr.c:1 · GitLab (127.0.0.1) refused the data (400): note rejected')
  await expect(progress().locator('.pstep.fail .sr-only')).toHaveText('failed: ')
  // Switching mode and back shows the same progress.
  await v.getByRole('button', { name: 'Switch to my branch mode' }).click()
  await v.getByRole('button', { name: 'Switch to MR mode' }).click()
  await expect(progress()).toContainText('Stopped')
  await expect(progress().getByRole('button', { name: 'Retry failed (1)' })).toBeVisible()
  await progress().locator('.pstep.fail').getByRole('button', { name: 'Skip' }).click()
  await expect(progress().locator('.pstep.skip')).toContainText('mr.c:1')
  await progress().getByRole('button', { name: 'Continue' }).click()
  await expect(progress()).toContainText('Posted')
  await expect(progress()).toContainText('3 of 4 · 1 skipped')
  expect(forge.calls.filter((c) => c.method === 'POST').map((c) => c.path.split('/merge_requests/7')[1])).toEqual(['/draft_notes', '/draft_notes', '/draft_notes', '/draft_notes/bulk_publish'])
})

test('a request that moved since the review stops the posting with one message', async () => {
  // A later commit on the branch: the forge still has the reviewed-on commit of its last check.
  writeFileSync(join(fx.alpha, 'later.txt'), 'later\n')
  git('add', '.')
  git('commit', '-q', '-m', 'feat: later')
  await v.getByRole('button', { name: 'Re-run' }).click()
  forge.calls.length = 0
  await post().getByRole('button', { name: 'Post 3 comments to MR !7' }).click()
  await expect(progress()).toContainText('Stopped')
  await expect(progress().getByText('The request moved since this review: re-run the review.')).toHaveCount(1)
  await expect(progress().locator('.pstep.fail')).toHaveCount(4)
  await expect(progress().getByRole('button', { name: /Retry|Skip|Continue/ })).toHaveCount(0)
  expect(forge.calls.filter((c) => c.method === 'POST')).toEqual([])
  await v.getByRole('button', { name: 'Exit review' }).click()
})

test('GitHub: the pull request of a branch gets one pending review', async () => {
  // beta: feature/gh adds gh.c; its remote is the fake GitHub at localhost.
  const g = (...args: string[]) => fx.git(fx.beta, ...args).trim()
  g('stash', '-q', '-u')
  g('switch', '-q', '-c', 'feature/gh')
  writeFileSync(join(fx.beta, 'gh.c'), 'int gh;\nint two;\n')
  g('add', 'gh.c')
  g('commit', '-q', '-m', 'feat: gh')
  g('remote', 'add', 'origin', `http://localhost:${forge.port}/acme/beta.git`)
  forge.prs.push({ repo: 'acme/beta', number: 45, title: 'Add gh.c', owner: 'acme', branch: 'feature/gh', base: 'main', author: 'octo', sha: g('rev-parse', 'HEAD') })
  writeFileSync(join(fx.root, 'review-answer'), [finding(['severity: important', 'file: gh.c', 'line: R1', 'end: R2', 'title: Two globals'], 'Group them.'), finding(['severity: minor', 'file: gh.c', 'line: R1', 'title: Name'], 'Rename gh.')].join('\n'))
  const b = await openRepo(page, 'beta')
  await b.getByRole('button', { name: 'Review', exact: true }).click()
  await dialog().getByRole('button', { name: 'GitHub', exact: true }).click()
  await dialog().getByRole('button', { name: 'Accounts…' }).click()
  const row = accounts().getByRole('region', { name: 'GitHub localhost' })
  await expect(row.getByLabel('Instance URL')).toHaveValue(`http://localhost:${forge.port}`)
  await row.getByLabel('Personal access token').fill(FAKE_TOKEN)
  await row.getByRole('button', { name: 'Test connection' }).click()
  await expect(row).toContainText('Connected as @octo')
  await accounts().getByRole('button', { name: 'Done' }).click()
  await expect(dialog().getByRole('status').filter({ hasText: 'Pull request #45' })).toContainText('Pull request #45 is open for this branch on localhost')
  await dialog().getByRole('button', { name: 'Start review' }).click()
  const panel = b.locator('aside.right')
  await expect(panel).toContainText('Post to pull request')
  await expect(panel.getByLabel('Post as a pending review (submit it on GitHub)')).toBeChecked()
  forge.calls.length = 0
  await panel.getByRole('button', { name: 'Post 2 comments to PR #45' }).click()
  await expect(panel.getByRole('status', { name: 'Posting' })).toContainText('Pending review (2 comments)')
  await expect(panel.getByRole('status', { name: 'Posting' })).toContainText('1 of 1')
  const head = forge.prs[0].sha
  expect(forge.calls.filter((c) => c.method === 'POST').map((c) => [c.path, c.body])).toEqual([
    [
      '/repos/acme/beta/pulls/45/reviews',
      {
        commit_id: head,
        body: '',
        comments: [
          { path: 'gh.c', line: 2, side: 'RIGHT', body: 'Group them.' },
          { path: 'gh.c', line: 1, side: 'RIGHT', body: 'Rename gh.' }
        ]
      }
    ]
  ])
  // Without the pending review: one comment per finding, no summary review.
  await b.getByRole('button', { name: 'Re-run' }).click()
  await panel.getByLabel('Post as a pending review (submit it on GitHub)').uncheck()
  forge.calls.length = 0
  await panel.getByRole('button', { name: 'Post 2 comments to PR #45' }).click()
  await expect(panel.getByRole('status', { name: 'Posting' })).toContainText('2 of 2')
  expect(forge.calls.filter((c) => c.method === 'POST').map((c) => [c.path, (c.body as { event?: string }).event])).toEqual([
    ['/repos/acme/beta/pulls/45/comments', undefined],
    ['/repos/acme/beta/pulls/45/comments', undefined]
  ])
})

test('a repository with no other branch says so instead of measuring forever', async () => {
  const g = await openRepo(page, 'gamma')
  const row = g.locator('.side-item').first()
  await row.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Review with Claude…' }).click()
  await expect(dialog().getByRole('status')).toHaveText('No other branch to compare with.')
  await dialog().getByRole('button', { name: 'Cancel' }).click()
})
