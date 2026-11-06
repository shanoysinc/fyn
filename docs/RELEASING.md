# Releasing Fyn

For maintainers. How a new version gets from `main` to everyone's installed copy.

## How updates work

1. Pushing a version tag (`v0.2.0`) starts [`.github/workflows/release.yml`](../.github/workflows/release.yml).
2. The workflow builds the Windows installers, **signs** the update files with the private signing key, and publishes a GitHub release with the installers, their `.sig` files and `latest.json`.
3. Installed copies of Fyn read `latest.json` from the newest release about 15 seconds after they start (or when you click **Settings → Updates → Check for Updates**).
4. Before installing, Fyn checks the download's signature against the public key built into the app (`plugins.updater.pubkey` in `src-tauri/tauri.conf.json`). A download that wasn't signed with the matching private key is rejected.

The repository must stay **public**: Fyn downloads updates without logging in to GitHub.

## One-time setup

The workflow needs the private signing key as a repository secret named `TAURI_SIGNING_PRIVATE_KEY` (**Settings → Secrets and variables → Actions**). If the key is password-protected, also add the password as `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.

From PowerShell, with the [GitHub CLI](https://cli.github.com) logged in:

```powershell
Get-Content "<path to your key file>" -Raw | gh secret set TAURI_SIGNING_PRIVATE_KEY --repo shanoysinc/fyn
```

**Never commit the private key**, and keep a backup somewhere safe (e.g. a password manager). If it's lost, no future update can be signed, and installed copies can never update again.

## Each release

One command, run on an up-to-date `main` with everything committed:

```powershell
bun run release patch    # 0.1.0 → 0.1.1  (fixes)
bun run release minor    # 0.1.0 → 0.2.0  (new features)
bun run release major    # 0.1.0 → 1.0.0
bun run release 0.3.0    # an exact version
bun run release patch --dry-run   # show what would happen, change nothing
```

[`scripts/release.ts`](../scripts/release.ts):

1. checks you're on `main`, nothing is uncommitted, you're in sync with GitHub and the tag is unused;
2. sets the version in `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` and `src-tauri/Cargo.lock`;
3. shows the plan and asks you to confirm;
4. commits, tags `vX.Y.Z` and pushes the branch and tag together.

Follow the build under the repository's **Actions** tab. The workflow refuses to run if the tag doesn't match the version in `tauri.conf.json`.

## Building signed installers locally

Normally unnecessary. To do it anyway, point the build at your key:

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY = "<path to your key file>"
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "<password, or empty>"
bun tauri build --config src-tauri/tauri.release.conf.json
```

Output: `src-tauri/target/release/bundle/` (installers plus `.sig` files).
