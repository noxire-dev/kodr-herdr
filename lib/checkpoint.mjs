// A turn's checkpoint: the whole working tree (tracked + untracked, minus .gitignore) as a
// commit under refs/kodr/checkpoints, without touching the user's index, HEAD or stash.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const git = (cwd, args, env) =>
  execFileSync("git", args, { cwd, env: { ...process.env, ...env }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** Null outside a git repo. `scratch`: a folder for the temporary index. */
export function checkpoint(cwd, { session, turn, scratch, previous }) {
  try {
    git(cwd, ["rev-parse", "--show-toplevel"]);
  } catch {
    return null;
  }
  let head = null;
  try { head = git(cwd, ["rev-parse", "--verify", "HEAD"]); } catch {}
  const index = path.join(scratch, `index-${process.pid}`);
  const env = { GIT_INDEX_FILE: index };
  try {
    git(cwd, head ? ["read-tree", head] : ["read-tree", "--empty"], env);
    git(cwd, ["add", "-A", "--", ":/"], env);
    const tree = git(cwd, ["write-tree"], env);
    const sha = git(cwd, ["commit-tree", tree, ...(head ? ["-p", head] : []), "-m", `kodr checkpoint ${session} #${turn}`],
      { GIT_AUTHOR_NAME: "kodr", GIT_AUTHOR_EMAIL: "kodr@localhost", GIT_COMMITTER_NAME: "kodr", GIT_COMMITTER_EMAIL: "kodr@localhost" });
    git(cwd, ["update-ref", `refs/kodr/checkpoints/${session}/${turn}`, sha]);
    const base = previous ?? head;
    const stat = base ? git(cwd, ["diff", "--shortstat", base, sha]) : "";
    return { sha, base, stat };
  } finally {
    fs.rmSync(index, { force: true });
  }
}

// Self-check: node checkpoint.mjs
if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, "/").replace(/^\//, "")}`) {
  const os = await import("node:os");
  const assert = (await import("node:assert")).default;
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "kodr-cp-"));
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "kodr-cp-scratch-"));
  git(repo, ["init", "-q"]);
  fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
  fs.writeFileSync(path.join(repo, ".gitignore"), "secret.txt\n");
  git(repo, ["add", "-A"]);
  git(repo, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);
  fs.writeFileSync(path.join(repo, "a.txt"), "two\n");
  fs.writeFileSync(path.join(repo, "new.txt"), "new\n");
  fs.writeFileSync(path.join(repo, "secret.txt"), "nope\n");
  const statusBefore = git(repo, ["status", "--porcelain"]);
  const first = checkpoint(repo, { session: "s", turn: 1, scratch });
  assert.match(first.stat, /2 files changed/);
  assert.equal(git(repo, ["show", `${first.sha}:a.txt`]), "two");
  assert.throws(() => git(repo, ["show", `${first.sha}:secret.txt`]));
  assert.equal(git(repo, ["status", "--porcelain"]), statusBefore, "user's index untouched");
  fs.writeFileSync(path.join(repo, "new.txt"), "newer\n");
  const second = checkpoint(repo, { session: "s", turn: 2, scratch, previous: first.sha });
  assert.match(second.stat, /1 file changed/);
  assert.equal(git(repo, ["rev-parse", "refs/kodr/checkpoints/s/2"]), second.sha);
  assert.equal(checkpoint(os.tmpdir(), { session: "s", turn: 1, scratch }), null);
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(scratch, { recursive: true, force: true });
  console.log("checkpoint: ok");
}
