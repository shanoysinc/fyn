# Fyn

A fast, keyboard-first launcher for Windows 11 (in the spirit of Raycast), built with Tauri v2 + Rust + React.

Press **Ctrl+Space** anywhere → type → **Enter**.

## Features (MVP)

- **Finds every app** – Start Menu shortcuts (`.lnk`, plus non-web `.url` like Steam games) and Store/MSIX apps from `shell:AppsFolder`.
- **Fuzzy search** in Rust ([nucleo](https://github.com/helix-editor/nucleo)) – `vsc` → Visual Studio Code, matched letters highlighted.
- **Smart ranking** – match quality + prefix bonus + frecency (how often / how recently you launch it).
- **Favorites** – pin apps, reorder them, open them with `Ctrl+1…9`.
- **Suggestions** – your most-used apps on the home screen.
- **Configurable global shortcut** – default `Ctrl+Space`, changed in Settings, swapped atomically (if the new one is taken, the old one stays).
- Tray icon, launch at login, single instance, hides on blur, opens on the monitor under your cursor, light/dark theme, acrylic background.

### Keyboard

| Keys | Action |
| --- | --- |
| `Ctrl+Space` | Show / hide Fyn (configurable) |
| `↑` `↓` / `Enter` | Move / open |
| `Ctrl+K` | Actions menu |
| `Ctrl+Enter` | Show in File Explorer |
| `Ctrl+Shift+Enter` | Run as administrator |
| `Ctrl+Shift+P` | Add / remove favorite |
| `Ctrl+Shift+↑` `↓` | Reorder favorite |
| `Ctrl+Shift+C` | Copy path |
| `Ctrl+1…9` | Open favorite N |
| `Ctrl+,` | Settings |
| `Esc` | Clear search, then hide |

## Development

### Prerequisites (one-time)

1. **Visual Studio Build Tools** with the **"Desktop development with C++"** workload, which must include a **Windows 11 SDK**.
   ```powershell
   winget install Microsoft.WindowsSDK.10.0.26100
   ```
   (or Visual Studio Installer → Modify → Individual components → *Windows 11 SDK*).
2. Rust – the exact toolchain is pinned in `rust-toolchain.toml` and installed automatically by rustup.
3. Node 20+.
4. WebView2 – preinstalled on Windows 11.

> **Git Bash users:** Git's `/usr/bin/link` shadows MSVC's `link.exe`. Run cargo/tauri from PowerShell or a *Developer PowerShell for VS*.

### Commands

```powershell
npm install
npm run app:dev     # run with hot reload
npm run app:build   # release build + MSI / NSIS installers in src-tauri/target/release/bundle
```

## Architecture

```
src-tauri/src/
  main.rs         wiring: plugins, setup, command registration
  indexer/        app discovery
    shortcuts.rs    Start Menu .lnk/.url (IShellLinkW)
    packaged.rs     Store apps via shell:AppsFolder
    cache.rs        apps.json snapshot for instant startup
  icons.rs        IShellItemImageFactory → PNG cache (parallel, 4 workers)
  search.rs       nucleo fuzzy match + ranking
  store.rs        SQLite (WAL): pins, usage, settings
  state.rs        shared state + background re-index pipeline
  watcher.rs      Start Menu file watcher (debounced)
  launcher.rs     ShellExecute open / runas, reveal in Explorer
  hotkey.rs       global shortcut register / swap / suspend
  window.rs       show on active monitor, hide on blur
  tray.rs         tray menu
  commands.rs     IPC surface (validated)
src/
  App.tsx         launcher view (cmdk)
  components/     ActionPanel, SettingsView, AppIcon, Kbd
  lib/            typed IPC, actions, shortcut formatting
```

### Performance

- **Instant open** – the window is created once and only shown/hidden. Nothing is scanned on open.
- **Instant startup** – the last catalogue is loaded from `apps.json`. A fresh scan runs on a background thread and pushes updates to the UI when it finishes.
- **Icons extracted once** – rendered by 4 parallel workers, cached as PNG files named by a hash of app ID + shortcut timestamp, and loaded lazily by the UI.
- **Search in Rust** – nucleo matches a few hundred apps in well under 1 ms. The UI drops stale responses so fast typing never flickers.
- **Small release binary** – LTO, `codegen-units=1`, `panic=abort`, stripped.
- **Index stays current** – a debounced file watcher picks up installs and uninstalls, and an out-of-date index (older than 10 minutes) is refreshed in the background on open.

### Security

- **Least-privilege IPC.** The webview only has permission to `listen`/`unlisten` to events (`capabilities/default.json`). It gets no file system, shell or HTTP access, and cannot control windows.
- **No paths or command lines from the UI.** Commands accept only an app **id**, and the backend looks it up in the catalogue it built itself. Anything unknown is rejected. The UI therefore cannot ask the backend to run an arbitrary program, even if the page were compromised.
- **Input limits.** Queries are capped at 256 characters, ids at 2 KB and shortcuts at 64 characters. Shortcuts must include a modifier, so a bare key can't capture normal typing.
- **No shell interpolation.** Apps are launched with `ShellExecuteW` on the indexed shortcut. Explorer gets a single quoted absolute path, and paths containing a quote are rejected. SQL is parameterised.
- **Strict CSP.** Scripts load only from `'self'`, with no `eval` and no remote content. The asset protocol can read only the `$APPLOCALDATA/icons/**` folder.
- **Run as administrator** always goes through the Windows UAC prompt. Fyn never runs elevated itself.
- **Fully offline.** Fyn makes no network requests.
- **Atomic writes.** The cache and icons are written to a temp file and renamed, so a crash can't corrupt them.
- **Release hardening.** No dev tools, no context menu, reload disabled.

## Roadmap

1. **Next:** inline calculator / unit conversion, system commands (lock, sleep, restart, empty recycle bin), Windows Settings pages, quicklinks & web search (`g query`).
2. **Then:** clipboard history, file search (Everything SDK), window switcher, snippets, aliases / per-app shortcuts.
3. **Later:** extension API, auto-update (`tauri-plugin-updater`, signed), code-signed installer.
