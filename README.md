# general-use-mods

Claude Code mods. This repository is a plugin marketplace, so each mod installs with one command.

## project-feature-tree

Shows what a project has built as a tree in a Claude Code pane: the project at the top, its modules below, each module's features below those. Under the tree, a Recommendations section lists features that are missing and what to build next, judged from the tree.

```
Shop 2 done · 1 planned
          ┌──────┐
          │ Shop │
          └───┬──┘
  ┌───────────┴───────────┐
┌─┴────────┐            ┌─┴───────────┐
│ Auth 1/2 │            │ Billing 1/1 │
└─┬────────┘            └─┬───────────┘
  ├─ ✓ Email login        └─ ✓ Stripe checkout
  └─ ○ Magic link

Recommendations
## Missing
- Auth: password reset, session expiry
## Next
1. Password reset: users locked out today have no recovery path
...
```

### Install

At the prompt of a Claude Code terminal session:

```
/plugin install project-feature-tree --marketplace notjaman/general-use-mods
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session).

From a shell:

```
claude plugin install project-feature-tree --marketplace notjaman/general-use-mods
```

In the desktop app, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `notjaman/general-use-mods`, then **Add plugin**.

If the repository is private, the install only works for people who can read it on GitHub and whose machine already has a git credential for github.com (an SSH key, or `gh auth login` then `gh auth setup-git`). The install never prompts for one.

### Usage

| Command | What it does |
|---|---|
| `/feature-tree` | Re-reads `FEATURES.md` and opens the pane |
| `/feature-tree scan` | Runs a background subagent that scans the codebase and writes `FEATURES.md`, or updates it if it exists. Nothing is posted in your conversation |
| `/feature-tree analyze` | Sends the tree to Claude Opus 5.5 and shows the recommendations under the tree |

First time in a project: run `/feature-tree scan`, wait for the `FEATURES.md updated` toast, then `/feature-tree analyze`.

How it behaves:

- **The tree lives in `FEATURES.md`** at the project root (the folder Claude Code was started in). It is plain Markdown, so you can edit it by hand and commit it.
- **The pane opens by itself** at session start in projects that already have `FEATURES.md`. On narrow terminals it waits until the window is at least 144 columns wide; `/feature-tree` opens it at any width.
- **The tree is a top-down chart**: the project box on top, a box per module with its done/total count, and the module's features stacked under it. Module cards wrap into more rows to fit the pane, so any size of project shows. Each module has its own color, planned features are dimmed, and labels too long for a card are cut with `…`.
- **The tree refreshes** after every Claude turn and on every `/feature-tree`.
- **Claude keeps it current.** While `FEATURES.md` exists, Claude is told to tick or add features in it as it finishes them.
- **Names stay simple.** Features are written in 2-5 plain words, the way a user would say them, with no library names, routes or other technical detail.
- **Rescanning is safe.** `/feature-tree scan` on an existing file keeps every module, feature and planned item. It adds new features, ticks finished ones and shortens any technical names.
- **Recommendations are cached per project.** They survive restarts and are marked stale once the tree changes. Run `/feature-tree analyze` again for a fresh set. Each run is one Opus call.

### FEATURES.md format

```markdown
# my-shop
- Auth
  - [x] Email login
  - [ ] Magic link
- Billing
  - [x] Stripe checkout
  - Invoices
```

- The first `# heading` is the project name; without one, the folder name is used.
- Top-level bullets are modules; nested bullets are their features. Deeper nesting is drawn too.
- `[x]` is built (✓), `[ ]` is planned (○). A bullet with no checkbox counts as built.
- Bullets can start with `-`, `*` or `+`; indent with spaces (a tab counts as two).

### Limits

- `FEATURES.md` is looked up in the folder Claude Code was started in. Started from a subfolder, it is not found.
- Where an organization manages Claude Code, the "keep FEATURES.md current" instruction to Claude does not run for plugins you install yourself. Everything else works.

### Updating

```
claude plugin update project-feature-tree@general-use-mods
```

Then run `/reload-plugins` in any open session.

## plan-tracker

Keeps a timeline of the plans Claude writes in plan mode for the project you are working in, in a Claude Code pane. Each row shows when the plan was written, its title, the module or feature it works on, and its status. The whole row takes the status color: green ● done, yellow ○ pending, red ● cancelled.

```
Plans · shop 2 done · 1 pending · 1 cancelled
Date    Plan                            Module / feature         Status
Oct 19  Magic link sign-in              Passwordless login       ○ pending
Oct 17  Stripe checkout webhook         Payments                 ● done
Oct 12  Drop the legacy admin path      Admin routing            ● cancelled
Sep 21  Speed up product … (file gone)  Image loading            ● done
```

### Install

```
/plugin install plan-tracker --marketplace notjaman/general-use-mods
```

From a shell: `claude plugin install plan-tracker --marketplace notjaman/general-use-mods`. In the desktop app, add it from **+**, **Plugins**, as above.

### Usage

| Command | What it does |
|---|---|
| `/plans` | Opens the pane and rescans |
| `/plans done <name>` | Marks a plan done by hand. `pending` and `cancel` work the same way |
| `/plans auto <name>` | Drops the hand-set status and goes back to the worked-out one |

`<name>` is any part of the plan's filename or title, among this project's plans. If it matches more than one plan, the command lists them.

### How status is worked out

Plan files hold no status. The mod reads Claude Code's session transcripts in `~/.claude/projects`, which log every plan Claude submits and your answer to it, and goes by your last answer:

| Your last answer | Status |
|---|---|
| Approved, and a `git commit` ran afterwards in that session | done |
| Approved, no commit yet | pending |
| Rejected with feedback (you typed what to change) | pending, or done once a commit follows |
| Rejected with no comment | cancelled |
| Never submitted, or never answered | pending |

A commit counts only when it ran as a command, succeeded, and came before the next plan was submitted in that session. A hand-set status always wins.

How it behaves:

- **This project only, newest first.** A plan belongs to the project when it was made in the folder Claude Code was started in, or a folder inside it. The date is when the plan was first written.
- **Feature labels come from Claude Haiku 5.5**, which reads each plan once and names its feature in 2-4 words. Labels are cached and redone only when a plan file changes; a row shows `…` until its label arrives. Only the open project's plans are labelled.
- **History is kept.** Claude Code deletes plan files after 30 days (the `cleanupPeriodDays` setting). The mod keeps every row it has seen, tagged `(file gone)`, and recovers older deleted plans from transcripts that still log their submit.
- **It refreshes** on `/plans` and after each Claude turn while the pane is open. A scan reads every transcript in the background, about 2 seconds for a few hundred MB.
- **The pane opens only on `/plans`.**

### Limits

- macOS and Linux only: it needs `perl` and `printenv` on the PATH, which both ship with macOS and most Linux systems.
- Status depends on Claude Code's wording for approving and rejecting a plan. If a release changes that wording, rows read pending until the mod is updated.
- Done is a guess from commits. A plan that changes no code (research, a diagnosis) never gets one; mark it with `/plans done`.
- Started from a subfolder, the pane shows only plans made in that subfolder or below it, not plans made at the project root.

### Updating

```
claude plugin update plan-tracker@general-use-mods
```

## Development

Load a mod straight from this checkout, with hot reload on save, by adding its folder to `~/.claude/settings.json` and restarting Claude Code once:

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "/path/to/general-use-mods/project-feature-tree"
  }
}
```

Separate several mod folders with `:`. Don't also install the same mod from the marketplace, or it loads twice.

Leave `version` out of a mod's `plugin.json`. Without it, each commit counts as a new version, so `claude plugin update` picks up every push. A fixed `version` that never gets bumped makes every update a no-op.

Check a mod before committing:

```
claude plugin validate project-feature-tree
claude plugin test project-feature-tree
```
