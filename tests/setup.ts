import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Isolate every test from the user's git configuration (gpg signing, hooks, pull.rebase…).
const file = join(mkdtempSync(join(tmpdir(), 'gitrep-gitconfig-')), 'gitconfig')
writeFileSync(
  file,
  '[user]\n\tname = Test User\n\temail = test@example.com\n[commit]\n\tgpgsign = false\n[tag]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n[pull]\n\trebase = false\n[diff]\n\tmnemonicPrefix = true\n'
)
process.env.GIT_CONFIG_GLOBAL = file
process.env.GIT_CONFIG_NOSYSTEM = '1'
// No editor ever opens in tests (CI has none): a git call that would need one fails fast instead of hanging.
process.env.GIT_EDITOR = 'false'
