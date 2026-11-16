# Social Space

Project rules, architecture notes, where things are and playbooks: `.claude/CLAUDE.md`.

<!-- repoctx-gates -->
## Change gates (repo-context kit)

Before you report work done or land it on main:

- Every screen, route, menu item or setting you add is listed in `.claude/context/features.json`.
- Write `.claude/context/changes/<branch>.json`: the features you touched, every spot you changed, each renamed
  or removed term (`changes: [{old, new}]`) and any old term kept on purpose (`kept: [{term, path, reason}]`).
- `python .githooks/repoctx-check.py check` must pass. The pre-push hook (pushes and fast-forwards to main or
  master) and the Claude Code Stop hook run it. Never bypass them: no `--no-verify`, no editing the hooks, no
  writing `.git/repoctx-override.json`. Only Nate overrides a gate, from Ava's Inbox.
<!-- /repoctx-gates -->
