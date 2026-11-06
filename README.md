<p align="center">
  <img src="src/assets/logo.png" width="96" height="96" alt="Fyn logo" />
</p>

<h1 align="center">Fyn</h1>

<p align="center">
  A fast, keyboard-first launcher for Windows 11.<br />
  Press <kbd>Ctrl</kbd>+<kbd>Space</kbd>, type a few letters, press <kbd>Enter</kbd>.
</p>

<p align="center">
  Built with <a href="https://tauri.app">Tauri 2</a>, Rust and React. Small, offline-first, no telemetry.
</p>

---

## Features

### Apps
- **Finds every app**: Start Menu shortcuts (`.lnk`, plus non-web `.url` such as Steam games) and Store/MSIX apps.
- **Fuzzy search in Rust** ([nucleo](https://github.com/helix-editor/nucleo)): `vsc` finds Visual Studio Code, with the matched letters highlighted.
- **Smart ranking**: match quality, prefix bonus and *frecency* (how often and how recently you open something).
- **Favorites**: pin apps, reorder them, and open them with <kbd>Ctrl</kbd>+<kbd>1</kbd>…<kbd>9</kbd>.
- **Suggestions**: your most-used apps on the home screen.
- Run as administrator, show in File Explorer, copy path.

### Built-in tools
| Type… | You get |
| --- | --- |
| `24*1.15`, `15% of 80`, `sqrt(2)` | **Calculator**: the answer appears instantly; <kbd>Enter</kbd> copies it |
| `g rust`, `yt lofi`, `gh tauri`, `w turing`, `ddg`, `b`, `npm`, `maps` | **Search a site directly** |
| anything | **Web search fallback** with your default engine (Google, DuckDuckGo or Bing) |
| `github.com`, `localhost:3000` | **Open the website** |
| `C:\Users`, `~\Downloads`, `%APPDATA%` | **Open the folder or file** (<kbd>Ctrl</kbd>+<kbd>Enter</kbd> shows it in Explorer) |
| `wifi`, `bluetooth`, `display`, `sound`… | **Windows Settings pages** (35+) |
| `lock`, `sleep`, `restart`, `shut down`, `sign out` | **System commands** (restart, shut down and sign out ask you to confirm) |
| `empty recycle bin`, `toggle windows dark mode` | **More system commands** |
| `emoji` | **Emoji picker** with search and recently used |
| `#7c3aed`, `rgb(…)`, `color` | **Color picker**: convert between HEX, RGB and HSL, or pick a color from anywhere on screen |

### Everything else
- Configurable global shortcut (if the new one is taken, the old one keeps working).
- Light, dark, or follow Windows, for Fyn only. Your PC's theme isn't touched.
- Welcome screen on first run.
- Signed auto-updates.
- Tray icon, launch at login (on by default; turning it off sticks), single instance, hides when it loses focus, opens on the monitor under your cursor, acrylic background.

## Keyboard shortcuts

| Keys | Action |
| --- | --- |
| <kbd>Ctrl</kbd>+<kbd>Space</kbd> | Show / hide Fyn (configurable) |
| <kbd>↑</kbd> <kbd>↓</kbd> / <kbd>Enter</kbd> | Move / run |
| <kbd>Ctrl</kbd>+<kbd>K</kbd> | All actions for the selected item |
| <kbd>Ctrl</kbd>+<kbd>Enter</kbd> | Show in File Explorer |
| <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Enter</kbd> | Run as administrator |
| <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd> | Add / remove favorite |
| <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>↑</kbd> <kbd>↓</kbd> | Reorder favorite |
| <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>C</kbd> | Copy path / URL |
| <kbd>Ctrl</kbd>+<kbd>1</kbd>…<kbd>9</kbd> | Open favorite N |
| <kbd>Ctrl</kbd>+<kbd>,</kbd> | Settings |
| <kbd>Ctrl</kbd>+<kbd>P</kbd> (color picker) | Pick a color from the screen |
| <kbd>Esc</kbd> | Clear search, go back, then hide |

## Install

Download the latest `.msi` or `-setup.exe` from the [Releases](../../releases) page and run it. Fyn starts in the tray. Press <kbd>Ctrl</kbd>+<kbd>Space</kbd> to open it.

Installed copies update themselves: Fyn checks for a new version shortly after it starts. You can also check from **Settings → Updates**.

## Development

### Prerequisites (one-time)

1. **Visual Studio Build Tools** with the **Desktop development with C++** workload, including a **Windows 11 SDK**:
   ```powershell
   winget install Microsoft.WindowsSDK.10.0.26100
   ```
2. **Rust**: the exact toolchain is pinned in `rust-toolchain.toml` and installed automatically by rustup.
3. **[Bun](https://bun.sh) 1.3+** (package manager and script runner): `powershell -c "irm bun.sh/install.ps1 | iex"`. Vite and Vitest also need **Node 22.22+** on your PATH.
4. **WebView2**: preinstalled on Windows 11.

> **Git Bash users:** if a build fails at the link step, Git's `/usr/bin/link` is shadowing MSVC's `link.exe`. Run the commands from PowerShell or a *Developer PowerShell for VS*.

### Commands

```powershell
bun install
bun run app:dev       # run with hot reload
bun run typecheck     # TypeScript
bun run test          # frontend tests (not `bun test`, which is Bun's own runner); test:all adds Rust
cd src-tauri; cargo test; cargo clippy
bun run app:build     # local release build + MSI / NSIS installers
```

### Dev vs. installed builds

`bun run app:dev` runs as **Fyn Dev** (`src-tauri/tauri.dev.conf.json`), a separate app identity from the installed **Fyn**:

| | Installed Fyn | Fyn Dev |
| --- | --- | --- |
| Data (favorites, usage, settings) | `%LOCALAPPDATA%\dev.fyn.launcher` | `%LOCALAPPDATA%\dev.fyn.launcher.dev` |
| Default shortcut | <kbd>Ctrl</kbd>+<kbd>Space</kbd> | <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Space</kbd> |
| Launch at login | On by default | Never registered |
| Tray name | Fyn | Fyn Dev |

So both can run side by side, and nothing you do in dev touches your everyday favorites.

### Developer menu

In dev builds, press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>D</kbd> (or click **DEV** in the footer) to jump straight to any screen or state: the welcome screen, settings, emoji and color pickers, a simulated "update available" notice, success and error toasts, resetting onboarding, and reloading the UI. The menu isn't included in release builds.

### Releasing

Maintainers: see [docs/RELEASING.md](docs/RELEASING.md). In short, `bun run release patch` bumps the version, tags it and pushes, and GitHub Actions publishes a signed release that installed copies pick up automatically.

## Architecture

```
src-tauri/src/
  main.rs         wiring: plugins, setup, command registration
  commands.rs     IPC surface (every input validated)
  indexer/        app discovery
    shortcuts.rs    Start Menu .lnk/.url (IShellLinkW)
    packaged.rs     Store apps via shell:AppsFolder
    cache.rs        apps.json snapshot for instant startup
  search.rs       nucleo fuzzy match + ranking
  system.rs       system commands, Settings pages, URLs and paths
  launcher.rs     ShellExecute open / runas, reveal in Explorer
  updater.rs      update check / install (tauri-plugin-updater)
  icons.rs        IShellItemImageFactory → PNG cache (4 parallel workers)
  store.rs        SQLite (WAL): pins, usage, settings
  state.rs        shared state + background re-index pipeline
  watcher.rs      Start Menu file watcher (debounced)
  hotkey.rs       global shortcut register / swap / suspend
  window.rs       show on active monitor, hide on blur, theme
  tray.rs         tray menu
src/
  App.tsx         launcher view (cmdk) + dev menu
  components/     Settings, Welcome, Emoji, Color, ActionPanel, icons
  lib/
    entries.ts      built-in commands, Settings pages, web search, URL/path detection
    calc.ts         calculator (a small parser, no eval)
    color.ts        color parsing and conversion
    fuzzy.ts        matcher for built-in commands
    ipc.ts          typed IPC
```

### Performance

- **Instant open**: the window is created once and only shown/hidden. Nothing is scanned on open.
- **Instant startup**: the last catalogue loads from `apps.json`; a fresh scan runs on a background thread.
- **Icons extracted once**: 4 parallel workers, cached as PNGs keyed by a hash of app id + shortcut timestamp, loaded lazily.
- **Search in Rust**: nucleo matches a few hundred apps in well under 1 ms; stale responses are dropped so fast typing never flickers.
- **Lazy extras**: the emoji data (~450 KB) only loads when the emoji picker opens.
- **Small release binary**: LTO, `codegen-units=1`, `panic=abort`, stripped.

### Security

- **Least-privilege IPC.** The webview may only `listen`/`unlisten` to events (`capabilities/default.json`). It gets no file system, shell or HTTP access. Everything goes through Fyn's own validated commands.
- **Apps by id only.** Launching an app takes an opaque id that the backend looks up in the catalogue it built itself, so the UI can't ask for an arbitrary program to run.
- **Everything else is validated in Rust:**
  - System commands are a fixed list.
  - Settings links must match `ms-settings:[a-z0-9-]`.
  - URLs must be `http(s)` with no spaces or quotes.
  - Typed paths must be absolute and exist.
  - The theme and search engine must be one of the known values.
- **Input limits.** Queries are capped at 256 characters, ids at 2 KB, URLs at 2 KB and paths at 1 KB. Shortcuts must include a modifier.
- **No shell interpolation.** Apps and paths open with `ShellExecuteW`; Explorer gets a single quoted absolute path and rejects quotes; SQL is parameterised.
- **Strict CSP.** No `eval`, no remote content. The asset protocol can read only `$APPLOCALDATA/icons/**`.
- **Run as administrator** always goes through UAC. Fyn never runs elevated itself.
- **Network use is limited to the update check.** Updates are verified against the bundled public key before they install.
- **Release hardening.** No dev tools, no context menu, reload disabled, no dev menu.

## Roadmap

- Unit and currency conversion in the calculator (`5 km in mi`)
- Clipboard history
- File search (Everything SDK / Windows Search)
- Window switcher
- Snippets and aliases
- Pin built-in commands and Settings pages to Favorites
- Extension API

## Credits

Emoji data from [unicode-emoji-json](https://github.com/muan/unicode-emoji-json) and [emojilib](https://github.com/muan/emojilib). The settings icon comes from [Lucide](https://lucide.dev) (ISC licence).
