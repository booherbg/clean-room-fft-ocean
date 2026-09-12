#!/usr/bin/env node
/**
 * Build the demo and publish it to the `gh-pages` branch.
 *
 * The site is static, so Pages just serves `dist/`. Rather than committing
 * build output onto the source branch, this writes the freshly built tree as
 * a single commit on an orphan `gh-pages` branch and force-pushes it — the
 * branch holds one commit, always the current build, and never grows.
 *
 *   node scripts/deploy-pages.mjs            # build + push
 *   node scripts/deploy-pages.mjs --dry-run  # build only, report the size
 *
 * Requires a remote named `origin` and push rights. Set the Pages source to
 * the `gh-pages` branch, root folder, once (see README).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, cpSync, writeFileSync, statSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dryRun = process.argv.includes("--dry-run");

const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { cwd: repo, stdio: "inherit", ...opts });
const capture = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { cwd: repo, encoding: "utf8", ...opts }).trim();

/** Recursive byte total, so the deploy reports what visitors will download. */
function treeBytes(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    total += entry.isDirectory() ? treeBytes(p) : statSync(p).size;
  }
  return total;
}

// Publishing a dirty tree would ship uncommitted work under a commit id that
// does not contain it. Refuse rather than lie about what is deployed.
const dirty = capture("git", ["status", "--porcelain"]);
if (dirty) {
  console.error(`Working tree is dirty — commit or stash first:\n${dirty}`);
  process.exit(1);
}

const sha = capture("git", ["rev-parse", "--short", "HEAD"]);
const branch = capture("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
console.log(`Building ${branch}@${sha} for GitHub Pages…`);

rmSync(join(repo, "dist"), { recursive: true, force: true });
run("npx", ["vite", "build"], { env: { ...process.env, PAGES: "1" } });

// Pages serves the branch as-is through Jekyll unless told otherwise, and
// Jekyll drops files and directories beginning with an underscore.
writeFileSync(join(repo, "dist", ".nojekyll"), "");

const mb = (treeBytes(join(repo, "dist")) / 1e6).toFixed(1);
console.log(`dist/ is ${mb} MB`);

if (dryRun) {
  console.log("--dry-run: built only, nothing pushed.");
  process.exit(0);
}

// Commit the build in a scratch clone so the source checkout is never
// switched to gh-pages (a failure mid-deploy would otherwise strand it).
const stage = mkdtempSync(join(tmpdir(), "pages-"));
try {
  cpSync(join(repo, "dist"), stage, { recursive: true });
  const git = (...args) => run("git", args, { cwd: stage });
  git("init", "-q", "-b", "gh-pages");
  git("add", "-A");
  git("-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", `Deploy ${sha}`);
  git("remote", "add", "origin", capture("git", ["remote", "get-url", "origin"]));
  git("push", "-f", "origin", "gh-pages");
  console.log(`Deployed ${sha} to gh-pages.`);
} finally {
  rmSync(stage, { recursive: true, force: true });
}
