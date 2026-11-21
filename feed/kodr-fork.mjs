#!/usr/bin/env node
// Forks a Claude Code conversation just before one of the person's messages: copies the transcript's
// lines up to that message into a new session file beside it (same project folder, so
// `claude --resume <id>` from the same cwd finds it). The original is never touched.
//   kodr-fork.mjs <transcript> <uuid>   prints {"ok":true,"session":"<new id>"} or {"error":"…"}
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

export function cut(text, uuid, session) {
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let l;
    try { l = JSON.parse(line); } catch { continue; }
    if (l.uuid === uuid) return out.length ? out.join("\n") + "\n" : null;
    if ("sessionId" in l) l.sessionId = session;
    out.push(JSON.stringify(l));
  }
  return null; // that message isn't in the transcript
}

if (process.argv[2] === "--self-check") {
  const t = [{ type: "user", uuid: "a", sessionId: "s" }, { type: "mode" }, { type: "assistant", uuid: "b", sessionId: "s" }, { type: "user", uuid: "c", sessionId: "s" }]
    .map((l) => JSON.stringify(l)).join("\n");
  assert.deepEqual(cut(t, "c", "n").trim().split("\n").map((l) => JSON.parse(l)), [{ type: "user", uuid: "a", sessionId: "n" }, { type: "mode" }, { type: "assistant", uuid: "b", sessionId: "n" }]);
  assert.equal(cut(t, "a", "n"), null); // nothing before the first message: start a new chat instead
  assert.equal(cut(t, "zz", "n"), null);
  console.log("fork: ok");
} else if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [file, uuid] = process.argv.slice(2);
  const out = (v) => { process.stdout.write(JSON.stringify(v)); process.exit(0); };
  if (!file || !uuid) out({ error: "usage: kodr-fork.mjs <transcript> <uuid>" });
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { out({ error: "Can't read the conversation" }); }
  const session = randomUUID();
  const body = cut(text, uuid, session);
  if (!body) out({ error: "Nothing before that message to fork" });
  fs.writeFileSync(path.join(path.dirname(file), `${session}.jsonl`), body);
  out({ ok: true, session });
}
