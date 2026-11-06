#!/usr/bin/env bun
// One-command release: bump the version everywhere, commit, tag and push.
// Pushing the tag starts .github/workflows/release.yml, which builds and publishes.
//
//   bun run release patch | minor | major | X.Y.Z   [--dry-run] [--yes]

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const BRANCH = "main";

const FILES = {
  pkg: join(ROOT, "package.json"),
  tauri: join(ROOT, "src-tauri", "tauri.conf.json"),
  cargo: join(ROOT, "src-tauri", "Cargo.toml"),
  lock: join(ROOT, "src-tauri", "Cargo.lock"),
};

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

export function nextVersion(current: string, bump: string): string {
  const m = SEMVER.exec(current);
  if (!m) throw new Error(`Current version "${current}" isn't X.Y.Z`);
  const [major, minor, patch] = m.slice(1).map(Number);
  switch (bump) {
    case "patch":
      return `${major}.${minor}.${patch + 1}`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    case "major":
      return `${major + 1}.0.0`;
    default:
      if (!SEMVER.test(bump)) throw new Error(`"${bump}" isn't patch, minor, major or X.Y.Z`);
      return bump;
  }
}

function isNewer(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] > pb[i];
  return false;
}

function git(...args: string[]): string {
  const r = Bun.spawnSync(["git", ...args], { cwd: ROOT, stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed:\n${r.stderr.toString().trim()}`);
  return r.stdout.toString().trim();
}

/** Replace exactly one match, so a format change fails loudly instead of silently. */
function replaceOnce(text: string, pattern: RegExp, replacement: string, file: string): string {
  const matches = text.match(new RegExp(pattern.source, pattern.flags.replace("g", "") + "g"));
  if (matches?.length !== 1) throw new Error(`Expected one version entry in ${file}, found ${matches?.length ?? 0}`);
  return text.replace(pattern, replacement);
}

type Texts = { pkg: string; tauri: string; cargo: string; lock: string };

/** Set the app version in every file that carries it. Pure: returns the new contents. */
export function applyVersion(t: Texts, next: string): Texts {
  return {
    pkg: replaceOnce(t.pkg, /("version":\s*")[^"]+(")/, `$1${next}$2`, "package.json"),
    tauri: replaceOnce(t.tauri, /("version":\s*")[^"]+(")/, `$1${next}$2`, "tauri.conf.json"),
    // Only the [package] version; dependency tables have their own `version = …` lines.
    cargo: replaceOnce(t.cargo, /(\[package\][^[]*?\nversion\s*=\s*")[^"]+(")/, `$1${next}$2`, "Cargo.toml"),
    lock: replaceOnce(t.lock, /(name = "fyn"\r?\nversion = ")[^"]+(")/, `$1${next}$2`, "Cargo.lock"),
  };
}

function fail(message: string): never {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const yes = args.includes("--yes") || args.includes("-y");
  const bump = args.find((a) => !a.startsWith("-"));
  if (!bump) fail("Usage: bun run release patch | minor | major | X.Y.Z  [--dry-run] [--yes]");

  const pkgText = readFileSync(FILES.pkg, "utf8");
  const tauriText = readFileSync(FILES.tauri, "utf8");
  const cargoText = readFileSync(FILES.cargo, "utf8");
  const lockText = readFileSync(FILES.lock, "utf8");

  const current = JSON.parse(tauriText).version as string;
  const pkgVersion = JSON.parse(pkgText).version as string;
  if (pkgVersion !== current) fail(`package.json (${pkgVersion}) and tauri.conf.json (${current}) disagree; fix that first`);

  let next: string;
  try {
    next = nextVersion(current, bump);
  } catch (e) {
    fail((e as Error).message);
  }
  // Releasing the current version is allowed once (e.g. the very first v0.1.0): it just
  // tags what's there. Anything else must be newer.
  const same = next === current;
  if (!same && !isNewer(next, current)) fail(`${next} isn't newer than the current ${current}`);
  const tag = `v${next}`;

  // Safety checks: right branch, nothing uncommitted, in sync with GitHub, tag unused.
  const branch = git("rev-parse", "--abbrev-ref", "HEAD");
  if (branch !== BRANCH) fail(`You're on "${branch}". Switch to ${BRANCH} first.`);
  if (git("status", "--porcelain")) fail("You have uncommitted changes. Commit or stash them first.");
  git("fetch", "origin", BRANCH, "--tags", "--quiet");
  const behind = Number(git("rev-list", "--count", `HEAD..origin/${BRANCH}`));
  if (behind > 0) fail(`${BRANCH} is ${behind} commit(s) behind GitHub. Run: git pull`);
  if (git("tag", "--list", tag)) fail(`Tag ${tag} already exists.`);

  const updated = same
    ? null
    : applyVersion({ pkg: pkgText, tauri: tauriText, cargo: cargoText, lock: lockText }, next);

  const ahead = Number(git("rev-list", "--count", `origin/${BRANCH}..HEAD`));
  const unpushed = ahead ? ` (plus ${ahead} unpushed commit(s))` : "";
  const steps = same
    ? [`Tag the current commit on ${BRANCH} as ${tag}${unpushed}`, `Push ${BRANCH} and ${tag} to GitHub`]
    : [
        "Update the version in package.json, tauri.conf.json, Cargo.toml, Cargo.lock",
        `Commit "release: ${tag}" on ${BRANCH}${unpushed}`,
        `Tag ${tag} and push both to GitHub`,
      ];
  steps.push("GitHub Actions builds the signed installers and publishes the release");
  console.log(`\n  Release ${same ? next : `${current} → ${next}`}\n`);
  steps.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
  console.log();

  if (dryRun) {
    console.log("  Dry run: nothing was changed.\n");
    return;
  }
  if (!yes) {
    const answer = prompt("  Continue? [y/N]")?.trim().toLowerCase();
    if (answer !== "y" && answer !== "yes") fail("Cancelled. Nothing was changed.");
  }

  if (updated) {
    writeFileSync(FILES.pkg, updated.pkg);
    writeFileSync(FILES.tauri, updated.tauri);
    writeFileSync(FILES.cargo, updated.cargo);
    writeFileSync(FILES.lock, updated.lock);
    git("add", FILES.pkg, FILES.tauri, FILES.cargo, FILES.lock);
    git("commit", "-m", `release: ${tag}`);
  }
  git("tag", "-a", tag, "-m", `Fyn ${tag}`);
  // Atomic: either both the branch and the tag reach GitHub, or neither does.
  git("push", "--atomic", "origin", BRANCH, tag);

  console.log(`\n  ✓ Pushed ${tag}. Follow the build at https://github.com/shanoysinc/fyn/actions\n`);
}

if (import.meta.main) main();
