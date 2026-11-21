// Where Kodr keeps per-terminal state: ~/.kodr-herdr/t/<terminal>/
//   session.json  { session, transcript, cwd, base, ended? }  written by the SessionStart hook; ended by SessionEnd
//   turns.json    { turns: [{ n, sha, stat, anchor, checks, results }] }
//   reviewed      the checkpoint sha the person last marked reviewed (written by the review mod)
//   asks/<id>.req.json, .ans.json, .end                permission requests and their answers
// and in a card's worktree git dir (feed/kodr-mission.mjs): kodr-review.json, kodr-pr.json, kodr-setup.json,
//   kodr-rounds.json { terminal, n, waiting }  review rounds armed by Send to its Claude
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const terminalDir = (t) => path.join(os.homedir(), ".kodr-herdr", "t", t);

export function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}

/** The last `bytes` of a file as whole lines (the first, partial line dropped). */
export function tailLines(file, bytes) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size, start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString("utf8").split("\n");
    if (start > 0) lines.shift();
    return lines.filter(Boolean);
  } catch {
    return [];
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** The uuid of the transcript's last top-level message, where a turn's checkpoint belongs. */
export function lastUuid(transcript) {
  if (!transcript) return null;
  const lines = tailLines(transcript, 256 * 1024);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const l = JSON.parse(lines[i]);
      if ((l.type === "assistant" || l.type === "user") && !l.isSidechain && l.uuid) return l.uuid;
    } catch {}
  }
  return null;
}

/** The transcript of a Claude session: ~/.claude/projects/<project>/<session>.jsonl, or null. */
export function transcriptOf(session) {
  const projects = path.join(os.homedir(), ".claude", "projects");
  let dirs = [];
  try { dirs = fs.readdirSync(projects); } catch {}
  for (const d of dirs) {
    const f = path.join(projects, d, `${session}.jsonl`);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

/** What a running Claude process reports about itself (~/.claude/sessions/<pid>.json), or null. */
export const claudeProcess = (pid) => readJson(path.join(os.homedir(), ".claude", "sessions", `${pid}.json`), null);

/** A review round waiting on this terminal's turn to end: the card's worktree and issue number, or null.
 * Only a linked worktree's .git is a file ("gitdir: …"); a main checkout or plain folder is skipped cheaply. */
export function roundDue(cwd, terminal) {
  try {
    const gd = /^gitdir: (.+)$/m.exec(fs.readFileSync(path.join(cwd, ".git"), "utf8"))?.[1]?.trim();
    const r = gd && readJson(path.join(path.resolve(cwd, gd), "kodr-rounds.json"), null);
    return r?.waiting && r.terminal === terminal && Number.isInteger(r.n) ? { wt: cwd, n: r.n } : null;
  } catch { return null; }
}
