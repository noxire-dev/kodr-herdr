#!/usr/bin/env node
// Mission control's data: the Rinai board (rinai.dev, over GitHub issues) for a folder's repository,
// through the `gh rinai` extension, so gh's own token is used and never handled here.
//   board <cwd>          {repo, viewer, columns:{future,todo,ongoing,in-review,blocked,done:[card]}, cycle:{open:[N], ...}, truncated}
//                        (`gh rinai api GET /board`: one read; cards carry `waiting` when it's on you)
//   brief <cwd> N        {brief}  the issue as its brief, from its Description on (what a person reads)
//   claim <cwd> N        {ok}     Ongoing, assigned to you
//   move <cwd> N COLUMN  {ok}
//   worktrees <cwd>      {worktrees:[{n, branch, path}]}  the repo's checkouts on rinai/<N>-… branches
//   worktree <cwd> N TITLE  {n, branch, path, made}  the card's checkout, made if missing: branch rinai/<N>-<title>
//                        from the default branch (origin/HEAD, fetched), at <worktrees.directory>/<repo>/<branch slug>
//                        like Herdr's New worktree (settings.json "worktrees.directory", default ~/.herdr/worktrees)
//   unworktree <cwd> PATH   {ok}  git worktree remove (refuses one with changes; the branch stays)
//   review <worktree> N  {ok}  starts a read-only Claude (claude -p, detached) on the branch's diff against the
//                        default branch; it writes <worktree's git dir>/kodr-review.json, which `worktrees` reports
//                        as each checkout's `review`: running | done {findings, summary, head} | error. Never edits or merges.
//                        Model: KODR_REVIEW_MODEL, else config.json "reviewModel", else Claude's default.
//   pr <worktree> N TITLE  {number, url, head}  after a clean review of HEAD: pushes the branch and opens a PR into the
//                        default branch that closes #N (or reuses the open one); kept in <git dir>/kodr-pr.json
//   merge <worktree> [TERMINAL]  {merged, cleanup}  gh pr merge --squash --match-head-commit HEAD, only when that PR holds the
//                        reviewed commit; then the worktree and its branch (local and on origin) go, unless they hold work
//                        the merge doesn't (uncommitted changes, commits after the merged one): cleanup {removed} | {kept: why}.
//                        TERMINAL, the card's Claude, is ended first so its folder can go.
//   send <worktree> N TERMINAL  {ok}  types the review's blockers and majors into the card's Claude and arms review rounds:
//                        when that Claude's turn ends (Stop hook: review <worktree> N --auto), the review runs again (round 2,
//                        3 … up to "rounds"), and findings left go back to it on their own; <git dir>/kodr-rounds.json
//   setup <worktree>     {ok|none}  runs the repo's setup command there, detached; <git dir>/kodr-setup.json (running|done|error, out)
//   accept <cwd> N       {ok}  runs the repo's accept command in the main checkout (after the card is Done);
//                        <common git dir>/kodr-accept-<N>.json
//   progress T...        {T: {done, total, since}}  each terminal's Claude task list and when its session began
//   settings <cwd> [JSON]  {key, setup, accept, autoMerge, rounds}  the repo's settings (~/.kodr-herdr/repos.json, by
//                        owner/repo), JSON merged in when given. autoMerge (off by default): a clean review of the latest
//                        commit opens the PR and squash-merges it on its own. Auto steps are logged to ~/.kodr-herdr/mission.log.
// Every answer is one JSON line; failures are {"error": "..."} with what to do about it.
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { mergeStep } from "../mod/kodr-mission/board.js";
import { readTasks } from "../lib/tasks.mjs";

const gh = (cwd, args) => new Promise((resolve, reject) => {
  execFile("gh", ["rinai", ...args], { cwd, maxBuffer: 32 << 20, timeout: 60_000, windowsHide: true }, (err, stdout, stderr) => {
    if (err) reject(new Error(explain(String(stderr || err.message))));
    else resolve(stdout);
  });
});

const git = (cwd, args) => new Promise((resolve, reject) => {
  execFile("git", args, { cwd, maxBuffer: 8 << 20, timeout: 600_000, windowsHide: true }, (err, stdout, stderr) => {
    if (err) reject(new Error(String(stderr || err.message).trim().split("\n").pop() || "git failed"));
    else resolve(stdout.trim());
  });
});

// Herdr's folder name for a branch (mods/worktree slug, minus its hash fallback: ours always has a number).
export const slug = (branch) => branch.normalize("NFC").replace(/[^\p{L}\p{M}\p{N}._-]+/gu, "-").replace(/^-+|-+$/g, "");
// rinai/246-agents-tab-delete-a-chat: the number, then up to five words of the title.
export const branchFor = (n, title) => `rinai/${n}-${title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").slice(0, 5).join("-")}`.replace(/-$/, "");
// `git worktree list --porcelain` → the checkouts on rinai/<N>-… branches.
export function parseWorktrees(text) {
  return text.replace(/\r/g, "").split("\n\n").flatMap((block) => {
    const wt = /^worktree (.+)$/m.exec(block)?.[1], br = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1];
    const n = /^rinai\/(\d+)(?:-|$)/.exec(br ?? "")?.[1], head = /^HEAD (\w+)$/m.exec(block)?.[1];
    return wt && n ? [{ n: Number(n), branch: br, path: wt, head }] : [];
  });
}
function worktreeRoot() {
  let dir = "~/.herdr/worktrees";
  try { dir = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config", "herdr-app", "settings.json"), "utf8")).worktrees?.directory || dir; } catch {}
  dir = dir.replace(/\\/g, "/");
  if (dir === "~" || dir.startsWith("~/")) dir = os.homedir().replace(/\\/g, "/") + dir.slice(1);
  return dir.replace(/\/+$/, "");
}

async function worktree(cwd, n, title) {
  const existing = parseWorktrees(await git(cwd, ["worktree", "list", "--porcelain"])).find((w) => w.n === Number(n));
  if (existing) return { ...existing, made: false };
  const common = await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const main = common.endsWith("/.git") ? common.slice(0, -5) : common;
  const branch = branchFor(n, title);
  const dir = `${worktreeRoot()}/${main.split("/").pop()}/${slug(branch)}`;
  const known = await git(main, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).then(() => true, () => false);
  if (known) await git(main, ["worktree", "add", dir, branch]);
  else {
    // Start from the default branch as the remote has it, not from whatever this checkout is on.
    let base = await git(main, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).catch(() => null);
    if (base) await git(main, ["fetch", "--quiet", "origin", base.replace(/^origin\//, "")]).catch(() => {});
    await git(main, ["worktree", "add", "-b", branch, dir, base ?? "HEAD"]);
  }
  return { n: Number(n), branch, path: dir, made: true };
}

// ---- review before merge

const REVIEW_TOOLS = ["Read", "Grep", "Glob", "Bash(git diff:*)", "Bash(git log:*)", "Bash(git show:*)", "Bash(git status:*)", "Bash(gh rinai brief:*)"];
const FINDINGS = {
  type: "object",
  required: ["summary", "findings"],
  properties: {
    summary: { type: "string", description: "One sentence: is this branch ready to merge, and why." },
    findings: { type: "array", items: { type: "object", required: ["level", "file", "what", "fix"], properties: {
      level: { enum: ["blocker", "major", "minor"] }, file: { type: "string" }, line: { type: "integer" },
      what: { type: "string" }, fix: { type: "string" } } } },
  },
};
export const reviewPrompt = (n, base) => [
  `You review the work on this branch (Rinai issue #${n}) before it can merge. Read only: never edit files, commit or push.`,
  `- Read the task with \`gh rinai brief ${n}\`, then the diff with \`git diff ${base}...HEAD\` and the files it touches.`,
  `- Each finding has a level: blocker (wrong, breaks something, or unsafe), major (should be fixed before merging), minor (a nit or a later improvement).`,
  `- Be concrete: file, line, what is wrong and what to do instead. No praise, no summary of the diff. No findings is a fine answer.`,
  `- Something the task asked for and the diff doesn't do is a finding.`,
].join("\n");

// The state file, as the card shows it: a running review whose process is gone has stopped; a done one
// for an older commit is stale.
export function reviewState(s, head, alive) {
  if (!s) return null;
  if (s.state === "running" && !alive(s.pid)) return { ...s, state: "error", error: "The review stopped before it finished." };
  if (s.state === "done") {
    const fix = s.findings.filter((f) => f.level !== "minor").length;
    return { ...s, fix, stale: Boolean(head && s.head && s.head !== head) };
  }
  return s;
}
const alive = (pid) => { try { return Boolean(pid) && process.kill(pid, 0); } catch (e) { return e.code === "EPERM"; } };
const stateFile = async (wt) => path.join(await git(wt, ["rev-parse", "--absolute-git-dir"]), "kodr-review.json");
const readState = (file) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } };

// origin's default branch when there is one, else a local main or master.
async function baseOf(wt) {
  const remote = await git(wt, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).catch(() => null);
  if (remote) return remote;
  for (const b of ["main", "master"]) if (await git(wt, ["rev-parse", "--verify", "--quiet", b]).then(() => true, () => false)) return b;
  throw new Error("No default branch to review against (no origin/HEAD, main or master).");
}

async function startReview(wt, n, auto = false) {
  const file = await stateFile(wt), rf = await roundsFile(wt);
  const now = readState(file);
  if (now?.state === "running" && alive(now.pid)) return { error: "A review is already running." };
  // A round the Stop hook starts counts on from the last; one you start begins again at 1 and disarms the rounds.
  const rounds = readState(rf);
  if (auto && !rounds?.waiting) return { error: "No review round is waiting." };
  const round = auto ? (now?.round ?? 1) + 1 : 1;
  if (auto) fs.writeFileSync(rf, JSON.stringify({ ...rounds, waiting: false }));
  else fs.rmSync(rf, { force: true });
  const env = { ...process.env };
  delete env.HC_TERMINAL_ID; // Kodr's hooks stay out of the reviewer's session
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "review-run", wt, n, String(round)],
    { cwd: os.homedir(), env, detached: true, stdio: "ignore", windowsHide: true }); // not in wt: Windows locks a process's cwd
  const { rounds: limit } = await settings(wt).catch(() => DEFAULTS);
  fs.writeFileSync(file, JSON.stringify({ state: "running", pid: child.pid, at: Date.now(), round, limit }));
  if (auto) log({ wt, n: Number(n), action: "review round", round });
  child.unref();
  return { ok: true };
}

async function runReview(wt, n, round = 1) {
  const file = await stateFile(wt), at = Date.now();
  const { rounds: limit, autoMerge } = await settings(wt).catch(() => DEFAULTS);
  const write = (s) => fs.writeFileSync(file, JSON.stringify({ ...s, at, ms: Date.now() - at, round, limit }));
  try {
    await review();
  } catch (e) {
    write({ state: "error", error: String(e?.message ?? e) });
  }
  await afterRun(wt, n, limit, autoMerge).catch((e) => log({ wt, n: Number(n), action: "after review", error: String(e?.message ?? e) }));

  async function review() {
    const base = await baseOf(wt), head = await git(wt, ["rev-parse", "HEAD"]);
    const dirty = Boolean(await git(wt, ["status", "--porcelain"]));
    if (!(await git(wt, ["diff", "--stat", `${base}...HEAD`]))) {
      return write({ state: "done", base, head, dirty, empty: true, findings: [], summary: `No commits on this branch beyond ${base} yet.` });
    }
    let model = process.env.KODR_REVIEW_MODEL;
    try { model ??= JSON.parse(fs.readFileSync(path.join(os.homedir(), ".kodr-herdr", "config.json"), "utf8")).reviewModel; } catch {}
    const args = ["-p", reviewPrompt(n, base), "--output-format", "json", "--json-schema", JSON.stringify(FINDINGS),
      "--permission-mode", "dontAsk", "--allowedTools", ...REVIEW_TOOLS, "--disallowedTools", "Edit", "Write", "NotebookEdit",
      ...(model ? ["--model", model] : [])];
    const out = await new Promise((resolve, reject) => execFile("claude", args, { cwd: wt, maxBuffer: 32 << 20, timeout: 20 * 60_000, windowsHide: true },
      (err, stdout, stderr) => (err && !stdout ? reject(new Error(String(stderr || err.message).trim().split("\n").pop())) : resolve(stdout))));
    const r = JSON.parse(out), got = r.structured_output;
    if (!got?.findings) throw new Error(r.result ? String(r.result).slice(0, 300) : "The reviewer gave no findings.");
    write({ state: "done", base, head, dirty, findings: got.findings, summary: got.summary ?? "", cost: r.total_cost_usd });
  }
}

// Once a review is written: rounds (send what's left back to the card's Claude, or stop) and auto-merge.
async function afterRun(wt, n, limit, autoMerge) {
  const head = await git(wt, ["rev-parse", "HEAD"]);
  const review = reviewState(readState(await stateFile(wt)), head, alive);
  const rf = await roundsFile(wt), rounds = readState(rf);
  const next = afterReview(review, rounds, limit);
  if (next === "send") {
    await hcRun(["send", rounds.terminal, findingsText(review)]);
    fs.writeFileSync(rf, JSON.stringify({ ...rounds, waiting: true, at: Date.now() }));
    log({ wt, n: Number(n), action: "sent findings", round: review.round, fix: review.fix });
  } else if (next !== "none") {
    fs.rmSync(rf, { force: true });
    log({ wt, n: Number(n), action: `rounds ${next}`, round: review.round });
  }
  if (!autoMerge || mergeStep(review, null, head) !== "open") return;
  // Auto-merge (opt-in per repo): the same gated steps as the card's buttons.
  const title = await gh(wt, ["brief", String(n)]).then((b) => /^# #\d+ (.+)$/m.exec(b)?.[1]).catch(() => null)
    ?? await git(wt, ["log", "-1", "--format=%s"]).catch(() => "");
  const pr = await openPr(wt, n, title);
  if (pr.error) return log({ wt, n: Number(n), action: "auto-merge", error: pr.error });
  log({ wt, n: Number(n), action: "auto PR", pr: pr.number, url: pr.url });
  const main = await mainOf(wt);
  const merged = await mergePr(wt, rounds?.terminal ?? (await terminalAt(wt)));
  log({ wt, n: Number(n), action: "auto-merge", ...merged });
  if (merged.merged) await afterDone(main, n);
}
// The live terminal started in a folder (a card's Claude), to end it before its worktree goes.
async function terminalAt(dir) {
  try {
    const list = JSON.parse(await hcRun(["ls", "--json"])).terminals ?? [];
    const norm = (p) => (p ?? "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    return list.find((x) => x.state === "live" && x.agent === "claude-code" && norm(x.cwd) === norm(dir))?.address ?? null;
  } catch { return null; }
}
// Done: Rinai's Done column (unless the card was just moved there), then the repo's accept command if it has one.
async function afterDone(main, n, move = true) {
  if (move) await gh(main, ["move", String(n), "done"]).catch((e) => log({ n: Number(n), action: "move done", error: e.message }));
  const { accept } = await settings(main);
  if (!accept) return { none: true };
  const r = startJob(await acceptFile(main, n), "accept-run", [main, String(n)], accept);
  log({ n: Number(n), action: "accept", command: accept, ...r });
  return r;
}

async function worktreesWithReviews(cwd) {
  const list = parseWorktrees(await git(cwd, ["worktree", "list", "--porcelain"]));
  return Promise.all(list.map(async (w) => {
    try {
      const dir = path.dirname(await stateFile(w.path));
      return { ...w, review: reviewState(readState(path.join(dir, "kodr-review.json")), w.head, alive), pr: readState(path.join(dir, "kodr-pr.json")),
        setup: jobState(readState(path.join(dir, "kodr-setup.json")), alive), rounds: readState(path.join(dir, "kodr-rounds.json")) };
    } catch { return w; }
  }));
}
// The accept command's last run per card number, from the main checkout's git dir.
async function accepts(cwd) {
  const dir = await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).catch(() => null);
  const out = {};
  if (dir) for (const f of fs.readdirSync(dir).filter((x) => /^kodr-accept-\d+\.json$/.test(x))) out[/\d+/.exec(f)[0]] = jobState(readState(path.join(dir, f)), alive);
  return out;
}

// ---- push + PR, then merge (squash, pinned to the reviewed commit). Both refuse unless mergeStep allows.

const ghPlain = (cwd, args) => new Promise((resolve, reject) => {
  execFile("gh", args, { cwd, maxBuffer: 8 << 20, timeout: 120_000, windowsHide: true }, (err, stdout, stderr) => {
    if (err) reject(new Error(explain(String(stderr || err.message))));
    else resolve(stdout.trim());
  });
});

async function where(wt) {
  const dir = path.dirname(await stateFile(wt)), head = await git(wt, ["rev-parse", "HEAD"]);
  const review = reviewState(readState(path.join(dir, "kodr-review.json")), head, alive);
  const prPath = path.join(dir, "kodr-pr.json");
  return { head, review, prPath, pr: readState(prPath), step: mergeStep(review, readState(prPath), head) };
}

export const prBody = (n, review) =>
  `Closes #${n}\n\nReviewed by Kodr at ${review.head.slice(0, 7)}: ${review.summary || "no findings to fix."}` +
  (review.findings?.length ? `\n\nMinor, left for later:\n${review.findings.map((f) => `- ${f.file}${f.line ? `:${f.line}` : ""}: ${f.what}`).join("\n")}` : "");

async function openPr(wt, n, title) {
  const w = await where(wt);
  if (w.step !== "open" && w.step !== "push") return { error: "Open a PR after a clean review of the latest commit." };
  const branch = await git(wt, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const base = (await baseOf(wt)).replace(/^origin\//, "");
  await git(wt, ["push", "-u", "origin", branch]);
  let pr = w.pr;
  if (!pr) {
    // One made outside Kodr for this branch is used as it is.
    const found = JSON.parse(await ghPlain(wt, ["pr", "list", "--head", branch, "--state", "open", "--json", "number,url"]) || "[]")[0];
    if (found) pr = { number: found.number, url: found.url, base };
    else {
      const url = await ghPlain(wt, ["pr", "create", "--base", base, "--head", branch, "--title", title || branch, "--body", prBody(n, w.review)]);
      pr = { number: Number(/\/pull\/(\d+)/.exec(url)?.[1]), url: url.split("\n").pop(), base };
    }
  }
  pr = { ...pr, head: w.head, at: Date.now() };
  fs.writeFileSync(w.prPath, JSON.stringify(pr));
  return pr;
}

async function mergePr(wt, terminal) {
  const w = await where(wt);
  const why = { push: "The PR is behind this branch: push first.", open: "Open a PR first.", merged: "Already merged.",
    review: "Merge needs a clean review of the latest commit." };
  if (w.step !== "merge") return { error: why[w.step] };
  await ghPlain(wt, ["pr", "merge", String(w.pr.number), "--squash", "--match-head-commit", w.head]);
  const pr = { ...w.pr, merged: true, mergedAt: Date.now() };
  fs.writeFileSync(w.prPath, JSON.stringify(pr));
  const done = await cleanup(wt, w.head, terminal).catch((e) => ({ kept: String(e?.message ?? e) }));
  if (done.kept && fs.existsSync(path.dirname(w.prPath))) fs.writeFileSync(w.prPath, JSON.stringify({ ...pr, kept: done.kept }));
  return { ...pr, cleanup: done };
}

// ---- per-repo settings

const KODR = path.join(os.homedir(), ".kodr-herdr");
const REPOS = path.join(KODR, "repos.json");
export const DEFAULTS = { setup: "", accept: "", autoMerge: false, rounds: 3 };
// owner/repo from a GitHub remote (https or ssh), else null.
export const repoKey = (url) => /github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/.exec(String(url ?? "").trim())?.[1] ?? null;
const mainOf = async (cwd) => { const c = await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]); return c.endsWith("/.git") ? c.slice(0, -5) : c; };
// Only known keys of the right type; rounds 1..10.
export function mergeSettings(now, patch) {
  const next = { ...DEFAULTS, ...now };
  for (const k of Object.keys(DEFAULTS)) if (k in patch && typeof patch[k] === typeof DEFAULTS[k]) next[k] = patch[k];
  next.rounds = Math.max(1, Math.min(10, Math.round(next.rounds) || DEFAULTS.rounds));
  return next;
}
async function settings(cwd, patch) {
  const key = repoKey(await git(cwd, ["remote", "get-url", "origin"]).catch(() => "")) ?? (await mainOf(cwd));
  const all = readState(REPOS) ?? {};
  if (patch) {
    all[key] = mergeSettings(all[key], JSON.parse(patch));
    fs.mkdirSync(KODR, { recursive: true });
    fs.writeFileSync(REPOS, JSON.stringify(all, null, 2));
  }
  return { key, ...DEFAULTS, ...all[key] };
}
const log = (entry) => { try { fs.appendFileSync(path.join(KODR, "mission.log"), JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n"); } catch {} };

// ---- the repo's own commands (setup in a new worktree, accept after Done), detached, output kept

function startJob(file, verb, args, command) {
  const now = readState(file);
  if (now?.state === "running" && alive(now.pid)) return { error: "It's already running." };
  const env = { ...process.env };
  delete env.HC_TERMINAL_ID;
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), verb, ...args], { env, detached: true, stdio: "ignore", windowsHide: true });
  fs.writeFileSync(file, JSON.stringify({ state: "running", pid: child.pid, at: Date.now(), command }));
  child.unref();
  return { ok: true };
}
export const tail = (text, max = 4096) => (text.length > max ? "…" + text.slice(-max) : text);
// The person's own shell command (from repos.json): its output's last 4 KB and exit code.
function runCommand(command, cwd, file) {
  const at = Date.now();
  return new Promise((resolve) => {
    let out = "";
    const env = { ...process.env };
    delete env.HC_TERMINAL_ID;
    const child = spawn(command, { cwd, shell: true, env, windowsHide: true });
    const add = (d) => { out = tail(out + d, 64 << 10); };
    child.stdout.on("data", add); child.stderr.on("data", add);
    let ended = false;
    const done = (code, err) => {
      if (ended) return;
      ended = true;
      const s = { state: code === 0 ? "done" : "error", command, code, out: tail(out), at, ms: Date.now() - at, ...(err ? { error: err } : {}) };
      fs.writeFileSync(file, JSON.stringify(s));
      resolve(s);
    };
    child.on("error", (e) => done(-1, String(e.message)));
    child.on("close", (code) => done(code == null ? -1 : code | 0)); // Windows reports some codes unsigned (npm: 4294963238 = -4058)
  });
}
const setupFile = async (wt) => path.join(await git(wt, ["rev-parse", "--absolute-git-dir"]), "kodr-setup.json");
const acceptFile = async (cwd, n) => path.join(await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]), `kodr-accept-${n}.json`);
// A running job whose process is gone has stopped.
export const jobState = (s, isAlive) => (s?.state === "running" && !isAlive(s.pid) ? { ...s, state: "error", error: "It stopped before it finished." } : s);

// ---- after a merge: the worktree and branch go, unless they hold work the merge doesn't.

export const keepReason = ({ dirty, ahead }) => dirty ? "it has uncommitted changes"
  : ahead ? `${ahead} commit${ahead === 1 ? " is" : "s are"} on it after the merged one` : null;
const hcBin = () => process.env.KODR_HC || readState(path.join(KODR, "config.json"))?.hc || "hc";
const hcRun = (args) => new Promise((resolve, reject) => execFile(hcBin(), args, { timeout: 30_000, windowsHide: true },
  (err, stdout, stderr) => (err ? reject(new Error(String(stderr || err.message).trim())) : resolve(stdout))));
async function cleanup(wt, mergedHead, terminal) {
  const main = await mainOf(wt), branch = await git(wt, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const dirty = Boolean(await git(wt, ["status", "--porcelain"]));
  const ahead = Number(await git(wt, ["rev-list", "--count", `${mergedHead}..HEAD`]).catch(() => "0"));
  const why = keepReason({ dirty, ahead });
  if (why) return { kept: why };
  // Its Claude's work is merged: end it, or its folder can't go (Windows) or goes from under it.
  if (terminal) { await hcRun(["kill", terminal]).catch(() => {}); await new Promise((r) => setTimeout(r, 1500)); }
  try { await git(main, ["worktree", "remove", "--force", wt]); }
  catch (e) {
    // git unregisters it before deleting files; a locked file (Windows) leaves the folder behind.
    if (parseWorktrees(await git(main, ["worktree", "list", "--porcelain"])).some((w) => w.path.toLowerCase() === wt.toLowerCase().replace(/\\/g, "/")))
      return { kept: `git couldn't remove the folder: ${e.message}` };
    try { fs.rmSync(wt, { recursive: true, force: true }); } catch {}
  }
  await git(main, ["branch", "-D", branch]).catch(() => {});
  await git(main, ["push", "--quiet", "origin", "--delete", branch]).catch(() => {}); // GitHub may have deleted it already
  log({ wt, action: "removed worktree", branch });
  return { removed: true, branch, path: wt };
}

// ---- review rounds: Send to its Claude, its next turn ends, the review runs again, until clean or the limit.

const roundsFile = async (wt) => path.join(await git(wt, ["rev-parse", "--absolute-git-dir"]), "kodr-rounds.json");
export const findingsText = (review) => {
  const fix = review.findings.filter((f) => f.level !== "minor");
  return [`Review round ${review.round ?? 1} of this branch found ${fix.length} thing${fix.length === 1 ? "" : "s"} to fix before it merges:`,
    ...fix.map((f, i) => `${i + 1}. [${f.level}] ${f.file}${f.line ? `:${f.line}` : ""}: ${f.what} Fix: ${f.fix}`),
    "Fix them and commit; the review runs again when you finish this turn."].join("\n");
};
// What follows a finished review while rounds are armed: send the findings back, stop at the limit, or done.
export function afterReview(review, rounds, limit) {
  if (!rounds) return "none";
  if (review?.state !== "done") return "stop";
  if (!review.fix) return "clean";
  return (review.round ?? 1) >= limit ? "limit" : "send";
}
async function send(wt, n, terminal) {
  const head = await git(wt, ["rev-parse", "HEAD"]);
  const review = reviewState(readState(await stateFile(wt)), head, alive);
  if (review?.state !== "done" || !review.fix) return { error: "Nothing to send: the review has nothing to fix." };
  await hcRun(["send", terminal, findingsText(review)]);
  fs.writeFileSync(await roundsFile(wt), JSON.stringify({ terminal, n: Number(n), waiting: true, at: Date.now() }));
  return { ok: true };
}

// ---- progress: the card's Claude's task list and when its session began.

function progress(terminals) {
  const out = {};
  for (const t of terminals) {
    if (/[\\/]|\.\./.test(t)) continue;
    const s = readState(path.join(KODR, "t", t, "session.json"));
    if (!s?.transcript) continue;
    const tasks = readTasks(s.transcript);
    let since = null;
    try {
      const fd = fs.openSync(s.transcript, "r"), buf = Buffer.alloc(64 << 10);
      const head = buf.toString("utf8", 0, fs.readSync(fd, buf, 0, buf.length, 0));
      fs.closeSync(fd);
      since = Date.parse(/"timestamp":"([^"]+)"/.exec(head)?.[1] ?? "") || null;
    } catch {}
    out[t] = { done: tasks.filter((x) => x.status === "completed").length, total: tasks.length, since };
  }
  return out;
}

// gh's and gh rinai's failures, said as what the person can do.
export function explain(msg) {
  const m = msg.trim();
  if (/ENOENT|not recognized|command not found/i.test(m) && !/rinai/.test(m)) return "GitHub CLI (gh) isn't installed.";
  if (/unknown command "rinai"|extension.*not found/i.test(m)) return "Rinai isn't installed: gh extension install noxire-dev/gh-rinai";
  if (/not in a repository/i.test(m)) return "This folder isn't a GitHub repository.";
  if (/point to a known GitHub host/i.test(m)) return "This repository's remote isn't on GitHub, so there's no PR to open.";
  if (/gh auth login|not logged in/i.test(m)) return "GitHub CLI isn't signed in: gh auth login";
  return m.replace(/^gh rinai: /, "").split("\n")[0] || "gh rinai failed";
}

// The brief from its Description on: the instructions before it are for agents.
export const forPerson = (brief) => {
  const i = brief.indexOf("\n## Description");
  return i < 0 ? brief : brief.slice(i + 1);
};

async function main([verb, cwd, n, col, ...rest]) {
  if (verb === "board") return JSON.parse(await gh(cwd, ["api", "GET", "/board"]));
  if (verb === "worktrees") return { worktrees: await worktreesWithReviews(cwd), accepts: await accepts(cwd), settings: await settings(cwd).catch(() => null) };
  if (verb === "review-run") { await runReview(cwd, n, Number(col) || 1); return { ok: true }; }
  if (verb === "review" && /^\d+$/.test(n ?? "")) return await startReview(cwd, n, col === "--auto");
  if (verb === "send" && /^\d+$/.test(n ?? "") && col) return await send(cwd, n, col);
  if (verb === "pr" && /^\d+$/.test(n ?? "")) return await openPr(cwd, n, col);
  if (verb === "merge") return await mergePr(cwd, n);
  if (verb === "settings") return await settings(cwd, n);
  if (verb === "progress") return progress([cwd, n, col, ...rest].filter(Boolean));
  if (verb === "setup") { const { setup } = await settings(cwd); return setup ? startJob(await setupFile(cwd), "setup-run", [cwd], setup) : { none: true }; }
  if (verb === "setup-run") { await runCommand((await settings(cwd)).setup, cwd, await setupFile(cwd)); return { ok: true }; }
  if (verb === "accept" && /^\d+$/.test(n ?? "")) return await afterDone(cwd, n, false);
  if (verb === "accept-run" && /^\d+$/.test(n ?? "")) { await runCommand((await settings(cwd)).accept, cwd, await acceptFile(cwd, n)); return { ok: true }; }
  if (verb === "unworktree") { await git(cwd, ["worktree", "remove", n]); return { ok: true }; }
  if (!/^\d+$/.test(n ?? "")) return { error: "usage: kodr-mission.mjs board|worktrees|brief|claim|move|worktree|unworktree <cwd> [N|PATH] [COLUMN|TITLE]" };
  if (verb === "worktree") return await worktree(cwd, n, col ?? "");
  if (verb === "brief") return { brief: forPerson(await gh(cwd, ["brief", n])) };
  if (verb === "claim") { await gh(cwd, ["claim", n]); return { ok: true }; }
  if (verb === "move" && ["future", "todo", "ongoing", "in-review", "blocked", "done"].includes(col)) { await gh(cwd, ["move", n, col]); return { ok: true }; }
  return { error: `unknown: ${verb} ${col ?? ""}`.trim() };
}

if (process.argv[2] === "--self-check") {
  assert.equal(forPerson("# #1 T\n\n## How to work this task\nx\n## Description\nbody"), "## Description\nbody");
  assert.equal(explain("gh rinai: not in a repository; pass -R OWNER/REPO\n"), "This folder isn't a GitHub repository.");
  assert.equal(explain('unknown command "rinai" for "gh"'), "Rinai isn't installed: gh extension install noxire-dev/gh-rinai");
  assert.equal(explain("None of the git remotes configured for this repository point to a known GitHub host. To tell gh about a new GitHub host, please use `gh auth login`"),
    "This repository's remote isn't on GitHub, so there's no PR to open.");
  assert.equal(branchFor(246, "Agents tab: delete a chat!"), "rinai/246-agents-tab-delete-a-chat");
  assert.equal(branchFor(7, "Ünïcode — only"), "rinai/7-n-code-only");
  assert.equal(slug("rinai/246-agents-tab"), "rinai-246-agents-tab");
  assert.deepEqual(parseWorktrees("worktree C:/r\nHEAD 1\nbranch refs/heads/main\n\nworktree C:/w/r/rinai-12-x\nHEAD 2\nbranch refs/heads/rinai/12-x\n\nworktree C:/d\nHEAD 3\ndetached\n"),
    [{ n: 12, branch: "rinai/12-x", path: "C:/w/r/rinai-12-x", head: "2" }]);
  // review states as the card sees them
  const up = () => true, gone = () => false;
  assert.equal(reviewState(null, "a", up), null);
  assert.equal(reviewState({ state: "running", pid: 1 }, "a", up).state, "running");
  assert.equal(reviewState({ state: "running", pid: 1 }, "a", gone).state, "error");
  const done = { state: "done", head: "a", findings: [{ level: "minor" }, { level: "blocker" }, { level: "major" }] };
  assert.deepEqual([reviewState(done, "a", up).fix, reviewState(done, "a", up).stale], [2, false]);
  assert.equal(reviewState(done, "b", up).stale, true);
  assert.equal(reviewState({ state: "done", head: "a", findings: [{ level: "minor" }] }, "a", up).fix, 0);
  assert.match(reviewPrompt(7, "origin/main"), /gh rinai brief 7[\s\S]*git diff origin\/main\.\.\.HEAD/);
  assert.match(prBody(7, { head: "abcdef123", summary: "Ready.", findings: [{ file: "a.js", line: 3, what: "nit" }] }),
    /^Closes #7\n\nReviewed by Kodr at abcdef1: Ready\.[\s\S]*- a\.js:3: nit$/);
  // per-repo settings: keyed by owner/repo, only known keys, rounds 1..10, auto-merge off by default
  assert.equal(repoKey("https://github.com/noxire-dev/issues-scratch.git"), "noxire-dev/issues-scratch");
  assert.equal(repoKey("git@github.com:a/b.git\n"), "a/b");
  assert.equal(repoKey("https://gitlab.com/a/b"), null);
  assert.deepEqual(mergeSettings(undefined, {}), DEFAULTS);
  assert.equal(DEFAULTS.autoMerge, false);
  assert.deepEqual(mergeSettings({ setup: "npm ci" }, { autoMerge: true, rounds: 99, evil: 1, accept: 5 }), { ...DEFAULTS, setup: "npm ci", autoMerge: true, rounds: 10 });
  // after a merge: remove only when nothing on the worktree is left out of it
  assert.equal(keepReason({ dirty: false, ahead: 0 }), null);
  assert.equal(keepReason({ dirty: true, ahead: 0 }), "it has uncommitted changes");
  assert.equal(keepReason({ dirty: false, ahead: 2 }), "2 commits are on it after the merged one");
  assert.equal(keepReason({ dirty: false, ahead: 1 }), "1 commit is on it after the merged one");
  // review rounds
  const armed = { terminal: "t9", waiting: false };
  assert.equal(afterReview({ state: "done", fix: 2, round: 1 }, null, 3), "none"); // never sent: no rounds
  assert.equal(afterReview({ state: "done", fix: 2, round: 1 }, armed, 3), "send");
  assert.equal(afterReview({ state: "done", fix: 1, round: 3 }, armed, 3), "limit");
  assert.equal(afterReview({ state: "done", fix: 0, round: 2 }, armed, 3), "clean");
  assert.equal(afterReview({ state: "error" }, armed, 3), "stop");
  assert.match(findingsText({ round: 2, findings: [{ level: "major", file: "a.js", line: 4, what: "Off by one.", fix: "Use <." }, { level: "minor", file: "b", what: "x", fix: "y" }] }),
    /^Review round 2 of this branch found 1 thing to fix[\s\S]*1\. \[major\] a\.js:4: Off by one\. Fix: Use <\.\n/);
  // jobs
  assert.equal(jobState({ state: "running", pid: 1 }, gone).state, "error");
  assert.equal(jobState({ state: "running", pid: 1 }, up).state, "running");
  assert.equal(tail("abcdef", 3), "…def");
  console.log("mission: ok");
} else if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2))
    .then((v) => process.stdout.write(JSON.stringify(v)))
    .catch((e) => process.stdout.write(JSON.stringify({ error: String(e?.message ?? e) })));
}
