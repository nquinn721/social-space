# Social Space project rules

## Shipping changes

1. Work on your own branch in your own worktree so parallel sessions don't collide.
2. When the change is done (typecheck, tests, and the app was actually run), commit or merge it onto `dev`.
3. Releasing is merging the one standing `dev` -> `main` PR. The installed app builds new `main` commits and
   offers Restart to update (or Ava installs it, see below). Merging that PR needs Nate's go-ahead.
4. Bump the version for every change that reaches `main` (PATCH for fixes, MINOR for features), in
   `package.json`, `package-lock.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` and `Cargo.lock`.
5. Release builds only through `npm run tauri:build`, which refuses anything but a clean `main`.

## Worktrees: you made it, you remove it

Whoever creates a worktree owns it. Finishing a change means it is on `dev` and its worktree and branch are gone:
`git worktree remove <path>` then `git branch -d <branch>`. Never remove someone else's unmerged worktree, and
never remove `D:\Projects\SocialManager-release` (the installed app's source folder). A weekly job
(`%USERPROFILE%\.cargo\worktree-janitor.ps1`, after the Sunday cargo sweep) removes merged, clean worktrees that
were left behind and lists the rest for their owners.

## Updates are managed by Ava

Ava installs updates through the hub update contract (`--version --json`, `--update check|apply|rollback --json`,
marker `%APPDATA%\com.socialmanager.desktop\hub-managed.json`; see Ava's `docs/hub-module-spec.md`). Keep every
part of it working. Every Tauri command must also be listed in `src-tauri/build.rs` and
`capabilities/default.json`, or the installed app rejects it.
