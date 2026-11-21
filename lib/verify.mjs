// Harness-run checks: commands come from .kodr/checks.json at the base commit (so the agent's
// edits can't change them) and run in a throwaway worktree at the checkpoint. Paths under `pin`
// (git pathspecs: the tests the checks run) are put back as the base commit has them first, so
// editing a test can't make it pass; tests the agent adds still run.
// { "setup": "npm ci", "pin": ["test/**", "**/*.test.js"], "checks": [{ "name": "test", "run": "npm test" }] }
import { exec as execCb, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execCb);
const TAIL = 2000, TIMEOUT = 600_000;
const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** The check list at `base`, or null when the repo has none. */
export function readChecks(cwd, base) {
  try {
    const spec = JSON.parse(git(cwd, ["show", `${base}:.kodr/checks.json`]));
    return Array.isArray(spec) ? { checks: spec } : spec;
  } catch {
    return null;
  }
}

// ponytail: the checked-out tree has no untracked deps (node_modules); `setup` installs them per run.
export async function verify(cwd, { base, sha }) {
  const spec = readChecks(cwd, base);
  if (!spec?.checks?.length) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kodr-verify-"));
  try {
    git(cwd, ["worktree", "add", "--detach", "--force", dir, sha]);
    if (spec.pin?.length) {
      // Pinned files the agent changed or deleted go back to the base version; ones it added stay.
      const changed = git(dir, ["diff", "--name-only", "--no-renames", sha, base, "--", ...spec.pin.map((p) => `:(glob)${p}`)]).split("\n").filter(Boolean);
      const atBase = changed.filter((f) => { try { git(dir, ["cat-file", "-e", `${base}:${f}`]); return true; } catch { return false; } });
      if (atBase.length) git(dir, ["checkout", base, "--", ...atBase]);
    }
    const run = async (name, command) => {
      try {
        const r = await exec(command, { cwd: dir, timeout: TIMEOUT, maxBuffer: 32 * 1024 * 1024 });
        return { name, ok: true, tail: (r.stdout + r.stderr).slice(-TAIL) };
      } catch (e) {
        return { name, ok: false, tail: `${e.stdout ?? ""}${e.stderr ?? ""}${e.killed ? "\n(timed out)" : ""}`.slice(-TAIL) };
      }
    };
    if (spec.setup) {
      const setup = await run("setup", spec.setup);
      if (!setup.ok) return { base, sha, ok: false, results: [setup] };
    }
    const results = [];
    for (const c of spec.checks) results.push(await run(c.name ?? c.run, c.run));
    return { base, sha, ok: results.every((r) => r.ok), results };
  } finally {
    try { git(cwd, ["worktree", "remove", "--force", dir]); } catch { fs.rmSync(dir, { recursive: true, force: true }); }
  }
}

// Self-check: node verify.mjs
if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, "/").replace(/^\//, "")}`) {
  const assert = (await import("node:assert")).default;
  const { checkpoint } = await import("./checkpoint.mjs");
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "kodr-verify-test-"));
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "kodr-verify-scratch-"));
  const commit = () => { git(repo, ["add", "-A"]); git(repo, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "c"]); };
  git(repo, ["init", "-q"]);
  fs.mkdirSync(path.join(repo, ".kodr"));
  fs.writeFileSync(path.join(repo, ".kodr/checks.json"), JSON.stringify({ checks: [{ name: "has-ok", run: "node -e \"process.exit(require('fs').readFileSync('v.txt','utf8').includes('ok')?0:1)\"" }] }));
  fs.writeFileSync(path.join(repo, "v.txt"), "ok\n");
  commit();
  const base = git(repo, ["rev-parse", "HEAD"]);
  const good = checkpoint(repo, { session: "s", turn: 1, scratch });
  assert.equal((await verify(repo, { base, sha: good.sha })).ok, true);
  // The agent empties v.txt and rewrites the check to always pass: the base's check still runs.
  fs.writeFileSync(path.join(repo, "v.txt"), "bad\n");
  fs.writeFileSync(path.join(repo, ".kodr/checks.json"), JSON.stringify({ checks: [{ name: "has-ok", run: "node -e 0" }] }));
  const bad = checkpoint(repo, { session: "s", turn: 2, scratch, previous: good.sha });
  const r = await verify(repo, { base, sha: bad.sha });
  assert.equal(r.ok, false);
  assert.equal(git(repo, ["worktree", "list"]).split("\n").length, 1, "worktree cleaned up");
  assert.equal(await verify(scratch, { base: "HEAD", sha: "HEAD" }), null);

  // Pinned tests: the check runs a test script; the agent breaks the code and rewrites the test
  // to pass. With the test pinned, the base's test runs and catches it; a test it adds still runs.
  const repo2 = fs.mkdtempSync(path.join(os.tmpdir(), "kodr-verify-pin-"));
  const commit2 = () => { git(repo2, ["add", "-A"]); git(repo2, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "c"]); };
  git(repo2, ["init", "-q"]);
  fs.mkdirSync(path.join(repo2, ".kodr")); fs.mkdirSync(path.join(repo2, "test"));
  fs.writeFileSync(path.join(repo2, ".kodr/checks.json"), JSON.stringify({ pin: ["test/**"], checks: [{ name: "tests", run: "node test/run.js" }] }));
  fs.writeFileSync(path.join(repo2, "v.txt"), "ok\n");
  fs.writeFileSync(path.join(repo2, "test/run.js"), "process.exit(require('fs').readFileSync('v.txt','utf8').includes('ok')?0:1)");
  commit2();
  const base2 = git(repo2, ["rev-parse", "HEAD"]);
  fs.writeFileSync(path.join(repo2, "v.txt"), "bad\n");
  fs.writeFileSync(path.join(repo2, "test/run.js"), "process.exit(0)");
  const cheat = checkpoint(repo2, { session: "s", turn: 1, scratch });
  assert.equal((await verify(repo2, { base: base2, sha: cheat.sha })).ok, false, "a rewritten test can't pass the check");
  fs.writeFileSync(path.join(repo2, "v.txt"), "ok\n");
  fs.writeFileSync(path.join(repo2, "test/run.js"), "process.exit(require('fs').readFileSync('v.txt','utf8').includes('ok')?0:1)");
  fs.writeFileSync(path.join(repo2, "test/extra.js"), "added by the agent");
  const fair = checkpoint(repo2, { session: "s", turn: 2, scratch, previous: cheat.sha });
  assert.equal((await verify(repo2, { base: base2, sha: fair.sha })).ok, true, "honest work still passes");
  fs.rmSync(repo2, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(scratch, { recursive: true, force: true });
  console.log("verify: ok");
}
