# Social Space

A Windows desktop app (Tauri 2 + React) for running brands and their social accounts.

## Install on a Windows PC

You need [Node.js](https://nodejs.org) 20 or newer and [Git](https://git-scm.com/download/win). Then, in a terminal:

```powershell
git clone https://github.com/nquinn721/social-space.git
cd social-space
npm start
```

`npm start` checks for the other build tools (Rust, the Visual Studio C++ Build Tools and the WebView2 runtime)
and offers to install any that are missing with winget. Windows may ask for permission, and the C++ Build Tools
take a while. If winget is not available, it prints a download link for each one; install them, open a new
terminal and run `npm start` again.

It then builds Social Space from `main` (the first build takes 5 to 15 minutes, later ones are faster), installs
it and starts it. Find it afterwards in the Start menu as Social Space.

Keep the `social-space` folder: the app updates itself from it. When new commits land on `main`, the app's
Updates page builds them in the background and offers a restart into the new version. Running `npm start` again
in the folder does the same by hand.

Options: `npm start -- --yes` installs missing tools without asking, `--no-launch` skips starting the app.

Without the build tools, you can instead download the installer from the
[latest release](https://github.com/nquinn721/social-space/releases/latest); that copy updates itself from releases.

## Development

- `npm run dev:app` runs the app with hot reload (`tauri dev`); `npm run dev` serves only the web UI.
- Checks: `npm run typecheck`, `npm test`, and `cargo test --locked` in `src-tauri`.
- Releases are built only through `npm run tauri:build`, which builds a clean `main`.
