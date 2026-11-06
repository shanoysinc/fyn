<p align="center">
  <img src="src/assets/logo.png" width="96" height="96" alt="Fyn logo" />
</p>

<h1 align="center">Fyn</h1>

<p align="center">
  A fast, keyboard-first launcher for Windows 11.<br />
  Press <kbd>Alt</kbd>+<kbd>Space</kbd>, type a few letters, press <kbd>Enter</kbd>.
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
- **Favorites**: pin apps, commands, Settings pages and websites, reorder them, and open them with <kbd>Ctrl</kbd>+<kbd>1</kbd>…<kbd>9</kbd>.
- **Suggestions**: your most-used apps on the home screen.
- Favorites and suggestions show as an **icon grid** (up to 3 rows, arrow keys to move) or a short list. **View all** in the section header (or the "View All Favorites" command) opens the full set. Choose the layout in Settings.
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
| `clipboard` | **Clipboard history**: search and paste text (and optionally images) you copied; opt-in, encrypted, never keeps passwords |
| `#7c3aed`, `rgb(…)`, `color` | **Color picker**: convert between HEX, RGB and HSL, or pick a color from anywhere on screen |

### Everything else
- Configurable global shortcut (if the new one is taken, the old one keeps working).
- Light, dark, or follow Windows, for Fyn only. Your PC's theme isn't touched.
- Welcome screen on first run.
- Signed auto-updates.
- Tray icon, launch at login (on by default; turning it off sticks), single instance, hides when it loses focus, opens on the monitor under your cursor, acrylic background.

### Clipboard history

Type `clipboard` to search and paste what you copied recently (<kbd>Enter</kbd> pastes into the app you were in). It's **off until you turn it on**, never leaves your PC, and protects sensitive copies in layers:

1. **Copies from password managers are never recorded**: Fyn honours the "don't record" flags that 1Password, Bitwarden, KeePass and others set (the same ones Windows' own clipboard history uses), and ignores copies made while those apps are in front. You can add your own apps in Settings.
2. **Known secrets are never kept**: API keys and tokens (GitHub, OpenAI, Anthropic, AWS, Stripe, Slack, Google, npm, JWTs…), private keys, credentials in URLs, `PASSWORD=` lines and card numbers (Luhn-checked). Patterns follow the gitleaks rule set.
3. **Password-like text is never kept**: anything that looks like a generated password is dropped the moment it's checked, never written to disk or held in memory. Optionally, Fyn also takes it off the clipboard after a minute (if you haven't copied something else since), remembering only that the clipboard changed, never what was on it.
4. **Everything else is encrypted on disk** with your Windows account (DPAPI), and deleted after 1, 7 or 30 days (max 200 items).
5. **Images are opt-in** (Settings → Include images): screenshots and copied pictures, up to 50, each stored as an encrypted file with an encrypted thumbnail. Fyn can't read what's inside a picture, so a screenshot of a password *would* be kept; that's why it's off by default. Turning it off deletes the saved images.
6. **Pause** for 15 minutes or until resumed, delete single items (<kbd>Ctrl</kbd>+<kbd>Backspace</kbd>) or **clear everything**; turning the feature off deletes it all.

No tool can recognise a human-chosen password like `Summer2024!` (it looks like ordinary text); that's what the short retention, Pause and delete are for.

## Keyboard shortcuts

| Keys | Action |
| --- | --- |
| <kbd>Alt</kbd>+<kbd>Space</kbd> | Show / hide Fyn (configurable) |
| <kbd>↑</kbd> <kbd>↓</kbd> / <kbd>Enter</kbd> | Move / run |
| <kbd>Ctrl</kbd>+<kbd>K</kbd> | All actions for the selected item |
| <kbd>Ctrl</kbd>+<kbd>Enter</kbd> | Show in File Explorer |
| <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Enter</kbd> | Run as administrator |
| <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd> | Add / remove favorite |
| <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>↑</kbd> <kbd>↓</kbd> | Reorder favorite |
| <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>C</kbd> | Copy path / URL |
| <kbd>Ctrl</kbd>+<kbd>1</kbd>…<kbd>9</kbd> | Open favorite N |
| <kbd>Ctrl</kbd>+<kbd>,</kbd> | Settings |
| <kbd>Ctrl</kbd>+<kbd>P</kbd> (inside the color picker: type `color`) | Eyedropper: Fyn hides and the pointer becomes a crosshair; click anywhere to grab that color (<kbd>Esc</kbd> cancels) |
| <kbd>Esc</kbd> | Clear search, go back, then hide |

## Install

Download the latest `.msi` or `-setup.exe` from the [Releases](../../releases) page and run it. Fyn starts in the tray. Press <kbd>Alt</kbd>+<kbd>Space</kbd> to open it.

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
| Default shortcut | <kbd>Alt</kbd>+<kbd>Space</kbd> | <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>Space</kbd> |
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
  clipboard/      clipboard history: watcher, secret detection, DPAPI encryption, paste
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
- **The eyedropper** captures the mouse and Esc only while you're picking a color: it takes the one click (so it doesn't reach the app underneath), then removes the capture. It gives up after 30 seconds.
- **Network use is limited to the update check.** Updates are verified against the bundled public key before they install.
- **Clipboard history is opt-in and private by design**: see [Clipboard history](#clipboard-history) above.
- **Release hardening.** No dev tools, no context menu, reload disabled, no dev menu.

## Roadmap

### ✅ Shipped in 0.1

- App search with fuzzy matching, frecency ranking, suggestions, and favorites (apps, commands, Settings pages, websites; icon row or list)
- Calculator, web search with site prefixes, open URLs and paths
- System commands (lock, sleep, restart, shut down, sign out, empty Recycle Bin, Windows dark mode) and 35+ Windows Settings pages
- Emoji picker; color picker with HEX/RGB/HSL conversion and a screen eyedropper
- Clipboard history with layered privacy protection
- Right-click actions menu, welcome tour, light/dark/system theme for Fyn, launch at login
- Signed auto-updates, one-command releases (`bun run release`), CI with ~390 tests

### 🔜 Next

- **Code-signed installer**, so Windows stops showing the "isn't commonly downloaded" / SmartScreen warning
- **Unit and currency conversion** in the calculator (`5 km in mi`, `20 usd in eur`)
- **Quicklinks**: saved searches and links with a placeholder (`jira {query}`)

### 💡 Later

- File search (Everything SDK / Windows Search)
- Window switcher, and window snapping (halves, thirds, other monitor)
- Snippets and aliases (`;email` → your address, `ps` → Photoshop)
- Beta update channel ("Get beta updates" in Settings)
- A magnifier for the eyedropper, for picking small details

## License

[MIT](LICENSE). Use it, change it, share it; keep the copyright notice.

## Credits

Emoji data from [unicode-emoji-json](https://github.com/muan/unicode-emoji-json) and [emojilib](https://github.com/muan/emojilib). The settings icon comes from [Lucide](https://lucide.dev) (ISC licence).
