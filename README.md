# general-use-mods

Claude Code mods. This repository is a plugin marketplace, so each mod installs with one command.

## project-feature-tree

Shows what a project has built as a tree in a Claude Code pane: the project at the top, its modules below, each module's features below those. Under the tree, a Recommendations section lists features that are missing and what to build next, judged from the tree.

```
my-shop  3 done · 1 planned
├─ Auth
│  ├─ ✓ Email login
│  └─ ○ Magic link
└─ Billing
   ├─ ✓ Stripe checkout
   └─ ✓ Invoices

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
| `/feature-tree scan` | Queues a prompt asking Claude to scan the codebase and write `FEATURES.md`, or update it if it exists |
| `/feature-tree analyze` | Sends the tree to Claude Opus 5.5 and shows the recommendations under the tree |

First time in a project: run `/feature-tree scan`, let Claude finish, then `/feature-tree analyze`.

How it behaves:

- **The tree lives in `FEATURES.md`** at the project root (the folder Claude Code was started in). It is plain Markdown, so you can edit it by hand and commit it.
- **The pane opens by itself** at session start in projects that already have `FEATURES.md`. On narrow terminals it waits until the window is at least 144 columns wide; `/feature-tree` opens it at any width.
- **The tree refreshes** after every Claude turn and on every `/feature-tree`.
- **Claude keeps it current.** While `FEATURES.md` exists, Claude is told to tick or add features in it as it finishes them.
- **Rescanning is safe.** `/feature-tree scan` on an existing file keeps your wording and your planned items; it only adds new features and ticks finished ones.
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

Check a mod before committing:

```
claude plugin validate project-feature-tree
claude plugin test project-feature-tree
```
