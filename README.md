# GitRep

Local multi-repo git client (Electron + React). A dashboard of all your repositories; a commit graph of every branch with search, isolate/hide, commit details and a context menu (checkout, branch, tag, cherry-pick, revert, reset); stashes; drag a branch onto another to merge, rebase or fast-forward, with conflict prediction; diffs with staging per file, hunk or line; and commit, merge and stash messages, commit explanations and merge advice suggested by Claude.

## Run

    npm install
    npm run dev          # development (hot reload)
    npm test             # tests (parsers + real temporary git repositories)
    npm run e2e          # end-to-end tests (builds, then drives the app with Playwright)
    npm run smoke        # checks that the window loads without errors

## Install in the GNOME launcher

    npm run package
    sh scripts/install-desktop.sh

## Configuration

`~/.config/GitRep/config.json`: list of repositories, open tabs, `settings.claudeModel` (default `haiku`), `settings.claudePath` (empty = resolved through your shell).

## Sandbox

This system restricts user namespaces (AppArmor), hence `--no-sandbox`. To re-enable the Chromium sandbox, create `/etc/apparmor.d/gitrep` (root required). Adapt the path to where the repository lives on your machine:

    abi <abi/4.0>,
    include <tunables/global>
    profile gitrep /home/kevin/gitrep/dist/linux-unpacked/gitrep flags=(unconfined) {
      userns,
      include if exists <local/gitrep>
    }

then run `sudo apparmor_parser -r /etc/apparmor.d/gitrep` and remove `--no-sandbox` from the `.desktop` file.
