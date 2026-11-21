#!/usr/bin/env node
// Lists past Claude Code sessions for the Past sessions picker: every ~/.claude/projects/*/<id>.jsonl,
// newest first, with its title, folder and first message. Transcripts run to hundreds of MB, so only
// each file's head (folder, first message) and tail (latest title) are read.
//   kodr-sessions.mjs   prints {"sessions":[{id, title, first, cwd, at, gone}]} or {"error":"…"}
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const HEAD = 64 * 1024, TAIL = 256 * 1024;

// A message the person typed (not a slash command's wrapper, a hook's text or a resumed summary).
const typed = (l) => {
  if (l.type !== "user" || l.isMeta || l.isSidechain || l.isCompactSummary) return null;
  if (l.origin && l.origin.kind !== "human") return null;
  const c = l.message?.content;
  const text = typeof c === "string" ? c : Array.isArray(c) ? c.filter((b) => b.type === "text").map((b) => b.text).join(" ") : "";
  const t = text.trim();
  return t && !t.startsWith("<") ? t.replace(/\s+/g, " ") : null;
};

const lines = (text) => text.split("\n").flatMap((s) => { try { return [JSON.parse(s)]; } catch { return []; } });

// head/tail: text from the file's start and end (a partial first or last line is skipped).
export function summarize(head, tail) {
  let cwd = null, first = null, title = null, ai = null;
  for (const l of lines(head)) {
    cwd ??= l.cwd ?? null;
    first ??= typed(l);
  }
  for (const l of lines(tail)) {
    cwd ??= l.cwd ?? null;
    if (l.type === "custom-title" && l.customTitle) title = l.customTitle;
    if (l.type === "ai-title" && l.aiTitle) ai = l.aiTitle;
  }
  for (const l of lines(head)) {
    if (l.type === "custom-title" && l.customTitle) title ??= l.customTitle;
    if (l.type === "ai-title" && l.aiTitle) ai ??= l.aiTitle;
  }
  if (!first) return null; // never talked to: nothing to go back to
  return { title: title ?? ai ?? first.slice(0, 80), first: first.slice(0, 200), cwd };
}

function read(file, size) {
  const fd = fs.openSync(file, "r");
  try {
    const part = (start, len) => { const b = Buffer.alloc(len); fs.readSync(fd, b, 0, len, start); return b.toString("utf8"); };
    return size <= HEAD + TAIL ? [part(0, size), ""] : [part(0, HEAD), part(size - TAIL, TAIL)];
  } finally { fs.closeSync(fd); }
}

export function list(dir = path.join(os.homedir(), ".claude", "projects")) {
  const out = [];
  for (const proj of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!proj.isDirectory()) continue;
    for (const f of fs.readdirSync(path.join(dir, proj.name))) {
      if (!f.endsWith(".jsonl")) continue;
      const file = path.join(dir, proj.name, f);
      try {
        const st = fs.statSync(file);
        const [head, tail] = read(file, st.size);
        const s = summarize(head, tail);
        if (s) out.push({ id: f.slice(0, -6), ...s, at: st.mtimeMs, gone: !s.cwd || !fs.existsSync(s.cwd) });
      } catch {}
    }
  }
  return out.sort((a, b) => b.at - a.at);
}

if (process.argv[2] === "--self-check") {
  const j = (...ls) => ls.map((l) => JSON.stringify(l)).join("\n");
  const user = (content, extra = {}) => ({ type: "user", cwd: "/r", message: { role: "user", content }, ...extra });
  assert.deepEqual(summarize(j({ type: "mode" }, user("<command-name>/clear</command-name>"), user("hi", { isMeta: true }),
    user([{ type: "text", text: "fix  the\nbug" }]), { type: "ai-title", aiTitle: "Old" }), j({ type: "ai-title", aiTitle: "Bug fix" })),
    { title: "Bug fix", first: "fix the bug", cwd: "/r" });
  assert.equal(summarize(j(user("a"), { type: "custom-title", customTitle: "Mine" }), j({ type: "ai-title", aiTitle: "AI" })).title, "Mine");
  assert.equal(summarize(j(user("only message")), "").title, "only message"); // no title yet: the first message
  assert.equal(summarize(j(user("woken", { origin: { kind: "hook" } })), ""), null);
  assert.equal(summarize(j({ type: "mode" }), ""), null); // never talked to
  console.log("sessions: ok");
} else if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(JSON.stringify({ sessions: list() })); }
  catch (e) { process.stdout.write(JSON.stringify({ error: String(e?.message ?? e) })); }
}
