#!/usr/bin/env node
// Publishes Kodr: HEAD's committed files, minus the working notes between sessions and the person, as one new commit
// on the `public` branch (its own history, nothing from the local one), authored with the GitHub noreply address.
//   node bin/publish.mjs "<message>"          builds the commit and prints what changed
//   node bin/publish.mjs "<message>" --push   …and pushes it to origin's main
//   node bin/publish.mjs --self-check
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Local only: handoffs, what's waiting on the person, and the briefs written for agents.
export const published = (file) => !/^(HANDOFF\.md|NEEDS-YOU\.md|docs\/brief-[^/]+\.md)$/.test(file);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const git = (args, opts = {}) => execFileSync("git", args, { cwd: root, encoding: "utf8", ...opts }).trim();

if (process.argv[2] === "--self-check") {
  for (const f of ["HANDOFF.md", "NEEDS-YOU.md", "docs/brief-crew.md"]) assert.equal(published(f), false, f);
  for (const f of ["README.md", "AGENTS.md", "docs/reference.md", "docs/screenshots/crew-done.png", "mod/kodr-chat/main.js", "x/HANDOFF.md"])
    assert.equal(published(f), true, f);
  console.log("publish: ok");
} else {
  const message = process.argv[2];
  if (!message || message.startsWith("--")) throw new Error('usage: node bin/publish.mjs "<message>" [--push]');
  const user = JSON.parse(execFileSync("gh", ["api", "user"], { encoding: "utf8" }));
  const author = [`user.name=${user.login}`, `user.email=${user.id}+${user.login}@users.noreply.github.com`];
  const dir = path.join(os.tmpdir(), `kodr-public-${process.pid}`);
  const has = git(["branch", "--list", "public"]);
  git(has ? ["worktree", "add", "--quiet", dir, "public"] : ["worktree", "add", "--quiet", "--orphan", "-b", "public", dir]);
  try {
    // The public tree is exactly HEAD's published files: clear it, then write each one from the commit.
    for (const f of fs.readdirSync(dir)) if (f !== ".git") fs.rmSync(path.join(dir, f), { recursive: true, force: true });
    for (const f of git(["ls-tree", "-r", "--name-only", "HEAD"]).split("\n").filter(published)) {
      fs.mkdirSync(path.join(dir, path.dirname(f)), { recursive: true });
      fs.writeFileSync(path.join(dir, f), execFileSync("git", ["show", `HEAD:${f}`], { cwd: root, maxBuffer: 64 << 20 }));
    }
    git(["-C", dir, "add", "-A"]);
    if (!git(["-C", dir, "status", "--porcelain"])) console.log("nothing changed since the last publish");
    else {
      git(["-C", dir, "-c", author[0], "-c", author[1], "commit", "--quiet", "-m", message]);
      console.log(git(["-C", dir, "log", "-1", "--stat", "--format=%h %s (%an <%ae>)"]));
    }
    if (process.argv.includes("--push")) console.log(git(["-C", dir, "push", "origin", "public:main"], { stdio: ["ignore", "pipe", "pipe"] }) || "pushed public -> origin/main");
  } finally {
    git(["worktree", "remove", "--force", dir]);
  }
}
