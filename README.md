# GitRep

Local multi-repo git client (Electron + React). A dashboard of all your repositories; a commit graph of every branch with search, isolate/hide, commit details and a context menu (checkout, branch, tag, cherry-pick, revert, reset); stashes; drag a branch onto another to merge, rebase or fast-forward, with conflict prediction; interactive rebase (reorder, reword, squash, fixup, drop, with a plan proposed by Claude) and push with `--force-with-lease` after a rewrite; undo and redo of every operation; a conflict editor (both sides named, block by block, editable result, rebase steps) with resolutions proposed by Claude or handed over to Claude Code in a terminal; diffs with staging per file, hunk or line; and commit, merge and stash messages, commit explanations and merge advice suggested by Claude.

## Run

    npm install
    npm run dev          # development (hot reload)
    npm test             # tests (parsers + real temporary git repositories)
    npm run e2e          # end-to-end tests (builds, then drives the app with Playwright)
    npm run smoke        # checks that the window loads without errors

## Undo

Undo (toolbar or Ctrl+Z) reverts the last operation done in GitRep, Redo (toolbar, Ctrl+Shift+Z or Ctrl+Y) replays it: commits and amends, checkouts, branch creation and deletion, tags, cherry-picks, reverts, resets (a hard reset brings the discarded local changes back), merges, rebases (interactive ones too), fast-forwards, pulls, stash push / pop / drop and discarded changes. The history is kept in memory, per repository, and is lost when GitRep quits. Undo never overwrites local changes (`git reset --keep`) and refuses when the repository was changed outside GitRep since: the history of that repository is then cleared.

## History graph

The graph lists the commits newest first across branches (`git log --date-order`). By default it draws the active branches: those with a commit in the last 30 days, plus the checked-out branch and its upstream. The "Branches shown" menu above the graph switches to 90 days or to all branches and tags, or isolates one branch whatever its age. In the sidebar, the other branches are folded under "N older branches".

## Commit message instructions

The sliders button next to "Generate with Claude" opens free-text instructions that are added to what Claude is told when it writes a commit message (language, prefixes, length...): one text for all repositories and one for the current repository, up to 4000 characters each, which wins on a conflict. The fixed output rules (plain message, subject of at most 72 characters) always apply. They are stored in the GitRep config on this computer (`settings.commitInstructions` and `commitInstructions` on each repository), never in the repository. A dot on the button shows that instructions are active.

## Install in the GNOME launcher

    npm run package
    sh scripts/install-desktop.sh

## Configuration

`~/.config/GitRep/config.json`: list of repositories, open tabs, `settings.claudeModel` (default `haiku`), `settings.claudePath` (empty = resolved through your shell), `settings.activeDays` (branches drawn by default: those with a commit in the last N days, 0 = all; default 30, set from the graph), `settings.sidebarWidth` and `settings.rightWidth` (pane widths in pixels, set by dragging their edges) and `settings.graphColumns` (widths in pixels of the graph, Author, Date and SHA columns of the history, set by dragging the header separators: 48 to 480, the graph 40 to 480 or 0 for automatic) and `settings.commitInstructions` (see above).

## Sandbox

This system restricts user namespaces (AppArmor), hence `--no-sandbox`. To re-enable the Chromium sandbox, create `/etc/apparmor.d/gitrep` (root required). Adapt the path to where the repository lives on your machine:

    abi <abi/4.0>,
    include <tunables/global>
    profile gitrep /home/kevin/gitrep/dist/linux-unpacked/gitrep flags=(unconfined) {
      userns,
      include if exists <local/gitrep>
    }

then run `sudo apparmor_parser -r /etc/apparmor.d/gitrep` and remove `--no-sandbox` from the `.desktop` file.
